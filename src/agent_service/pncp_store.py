"""Índice local de oportunidades PNCP no Qdrant (coleção `driago_pncp`).

Transforma o acesso ao PNCP de "consulta reativa lenta" (bate na API a cada
pergunta, sofre rate-limit) para "radar com busca semântica instantânea":

- O ETL (`pncp_etl.py`) coleta editais da API e chama `upsert_opportunities`.
- O agente (`research.py`) consulta `search_local` — busca vetorial em ms,
  com matching semântico de verdade (nomic-embed-text), filtros por UF, faixa
  de valor e "ainda aberto".

Dedup idempotente: o ID do ponto é determinístico a partir do
`numeroControlePNCP` (uuid5), então re-ingerir o mesmo edital atualiza em vez
de duplicar. `upsert_opportunities` também reporta quais editais são NOVOS
(não existiam antes) — insumo para os alertas proativos.

Vetor: 768d Cosine (mesmo embedding nomic-embed-text das outras coleções).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from datetime import datetime, timezone

import httpx

from config import config
from models import PncpSource

COLLECTION = os.getenv("PNCP_COLLECTION", "driago_pncp")
_QDRANT = config.memory.qdrant_url
_EMBED_MODEL = config.memory.embed_model  # nomic-embed-text (768d)
_OLLAMA = config.rag.ollama_url
_NAMESPACE = uuid.UUID("6f9b1e7a-0000-4000-8000-000000000abc")  # estável p/ uuid5
_FAR_FUTURE = 4102444800  # 2100-01-01 — usado p/ encerramento desconhecido
_MIN_SCORE = float(os.getenv("PNCP_LOCAL_MIN_SCORE", "0.45"))
# Folga mínima (dias) até o fim do recebimento p/ a oportunidade ser "entrável".
# Esconde os "em cima da hora" por padrão; o usuário pode pedir prazos curtos.
_MIN_DIAS_ENTRADA = int(os.getenv("PNCP_MIN_DIAS_ENTRADA", "4"))
# TTL da faxina: edital parado no índice há mais que isso é removido (rede de
# segurança; o corte principal é o recebimento já encerrado).
_TTL_DIAS = int(os.getenv("PNCP_TTL_DIAS", "10"))

_EMBEDDING_CACHE: dict[str, list[float]] = {}


# ─── Embeddings ───────────────────────────────────────────────────────────────


async def _embed(text: str) -> list[float]:
    """Gera embedding via Ollama (nomic-embed-text) com cache MD5."""
    key = hashlib.md5(text.encode()).hexdigest()
    if key in _EMBEDDING_CACHE:
        return _EMBEDDING_CACHE[key]
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{_OLLAMA}/api/embeddings",
            json={"model": _EMBED_MODEL, "prompt": text},
        )
        resp.raise_for_status()
        emb = resp.json().get("embedding", [])
    _EMBEDDING_CACHE[key] = emb
    return emb


# ─── Coleção ──────────────────────────────────────────────────────────────────


async def ensure_collection() -> bool:
    """Cria a coleção driago_pncp e índices de payload se não existirem."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{_QDRANT}/collections")
        resp.raise_for_status()
        existing = {c["name"] for c in resp.json().get("result", {}).get("collections", [])}

        if COLLECTION not in existing:
            r = await client.put(
                f"{_QDRANT}/collections/{COLLECTION}",
                json={
                    "vectors": {"size": 768, "distance": "Cosine"},
                    "on_disk_payload": True,
                },
            )
            r.raise_for_status()
            print(f"[PNCP-STORE] Coleção '{COLLECTION}' criada")

        # Índices de payload p/ filtros (idempotente — ignora se já existe).
        for field, schema in [
            ("uf", "keyword"),
            ("numero_controle", "keyword"),
            ("encerra_epoch", "integer"),
            ("divulgacao_epoch", "integer"),
            ("ingested_epoch", "integer"),
            ("valor_num", "float"),
            ("modalidade_id", "integer"),
        ]:
            try:
                await client.put(
                    f"{_QDRANT}/collections/{COLLECTION}/index",
                    json={"field_name": field, "field_schema": schema},
                )
            except Exception:
                pass
    return True


# ─── Mapeamento item bruto → payload/ID ──────────────────────────────────────


def point_id(numero_controle: str) -> str:
    """ID determinístico do ponto (uuid5) — garante dedup idempotente."""
    return str(uuid.uuid5(_NAMESPACE, numero_controle or "sem-controle"))


def _epoch(iso: str, default: int = _FAR_FUTURE) -> int:
    """Converte ISO em unix-epoch. Desconhecido → `default`.

    encerramento desconhecido → _FAR_FUTURE (tratado como aberto, defensivo);
    abertura desconhecida → 0 (tratada como antiga, não ganha prioridade).
    """
    if not iso:
        return default
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except (ValueError, AttributeError):
        return default


def _valor_num(value) -> float:
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0


def _embed_text(item: dict) -> str:
    """Texto representativo do edital para o embedding (objeto domina)."""
    objeto = str(item.get("objetoCompra", "") or "")[:1200]
    modalidade = str(item.get("modalidadeNome", "") or "")
    unidade = item.get("unidadeOrgao") or {}
    local = "/".join(p for p in [unidade.get("municipioNome", ""), unidade.get("ufSigla", "")] if p)
    return f"{objeto} | Modalidade: {modalidade} | Local: {local}".strip()


def _to_payload(item: dict) -> dict:
    import pncp_client  # evita ciclo de import no topo

    orgao = item.get("orgaoEntidade") or {}
    unidade = item.get("unidadeOrgao") or {}
    divulgacao = str(item.get("dataPublicacaoPncp", "") or "")
    encerramento = str(item.get("dataEncerramentoProposta", "") or "")
    now_epoch = int(datetime.now(timezone.utc).timestamp())
    return {
        "numero_controle": str(item.get("numeroControlePNCP", "") or ""),
        "objeto": str(item.get("objetoCompra", "") or "")[:2000],
        "orgao": str(orgao.get("razaoSocial", "") or ""),
        "orgao_cnpj": str(orgao.get("cnpj", "") or ""),
        "uf": str(unidade.get("ufSigla", "") or ""),
        "municipio": str(unidade.get("municipioNome", "") or ""),
        "codigo_ibge": str(unidade.get("codigoIbge", "") or ""),
        "modalidade": str(item.get("modalidadeNome", "") or ""),
        "modalidade_id": int(item.get("modalidadeId") or 0),
        "valor_num": _valor_num(item.get("valorTotalEstimado")),
        "valor_fmt": pncp_client._format_value(item.get("valorTotalEstimado")),
        # Divulgação no PNCP = marco de frescor (confiável via /publicacao).
        "divulgacao": divulgacao,
        "divulgacao_epoch": _epoch(divulgacao, default=0),
        "abertura": str(item.get("dataAberturaProposta", "") or ""),
        # Fim de recebimento de propostas = define se ainda dá pra entrar.
        "encerramento": encerramento,
        "encerra_epoch": _epoch(encerramento, default=_FAR_FUTURE),
        "situacao": str(item.get("situacaoCompraNome", "") or ""),
        "url": pncp_client.public_url(item),
        "ingested_at": datetime.now(timezone.utc).isoformat(),
        "ingested_epoch": now_epoch,  # p/ TTL da faxina
    }


def _payload_to_source(p: dict) -> PncpSource:
    return PncpSource(
        numero_controle=p.get("numero_controle", ""),
        orgao=p.get("orgao", ""),
        uf=p.get("uf", ""),
        municipio=p.get("municipio", ""),
        modalidade=p.get("modalidade", ""),
        objeto=p.get("objeto", ""),
        valor=p.get("valor_fmt", ""),
        abertura=p.get("abertura", ""),
        encerramento=p.get("encerramento", ""),
        url=p.get("url", ""),
    )


# ─── Ingestão (upsert idempotente + detecção de novos) ───────────────────────


async def _existing_vectors(
    client: httpx.AsyncClient, ids: list[str]
) -> dict[str, list[float]]:
    """Retorna {id: vetor} dos pontos que já existem na coleção.

    Traz o vetor junto (`with_vector=True`) para que o upsert possa REUSAR o
    embedding dos editais já indexados em vez de regerá-lo no Ollama — o texto
    do edital não muda depois de publicado. É o que evita o re-embedding inútil
    de milhares de editais a cada passada do ETL (o caso `novos=0`).
    """
    if not ids:
        return {}
    try:
        resp = await client.post(
            f"{_QDRANT}/collections/{COLLECTION}/points",
            json={"ids": ids, "with_payload": False, "with_vector": True},
        )
        resp.raise_for_status()
        out: dict[str, list[float]] = {}
        for p in resp.json().get("result", []):
            vec = p.get("vector")
            if vec:
                out[str(p.get("id"))] = vec
        return out
    except Exception as e:
        print(f"[PNCP-STORE] checagem de existentes falhou: {e}")
        return {}


async def upsert_opportunities(items: list[dict]) -> dict:
    """Indexa editais brutos no Qdrant (idempotente).

    Returns:
        dict com {"upserted": int, "new": int, "new_items": list[dict]}
        onde new_items são os editais que NÃO existiam antes (p/ alertas).
    """
    # Dedup interno por numero_controle (a API pode repetir entre páginas/modalidades).
    by_controle: dict[str, dict] = {}
    for it in items:
        nc = str(it.get("numeroControlePNCP", "") or "")
        if nc:
            by_controle[nc] = it
    uniq = list(by_controle.values())
    if not uniq:
        return {"upserted": 0, "new": 0, "new_items": []}

    ids = [point_id(str(it["numeroControlePNCP"])) for it in uniq]

    async with httpx.AsyncClient(timeout=30.0) as client:
        existing = await _existing_vectors(client, ids)

        # Embedding APENAS dos editais novos; os já indexados reusam o vetor
        # existente (texto não muda após publicado). É o que derruba o uso de
        # CPU do Ollama quando a passada não traz novidade (`novos=0`).
        # Concorrência limitada nos novos p/ não saturar o Ollama.
        sem = asyncio.Semaphore(4)

        async def _vec_for(it, pid):
            cached = existing.get(pid)
            if cached:
                return cached
            async with sem:
                return await _embed(_embed_text(it))

        vectors = await asyncio.gather(
            *[_vec_for(it, pid) for it, pid in zip(uniq, ids)],
            return_exceptions=True,
        )

        points: list[dict] = []
        new_items: list[dict] = []
        embedded_new = 0
        for it, pid, vec in zip(uniq, ids, vectors):
            if isinstance(vec, Exception) or not vec:
                print(f"[PNCP-STORE] embedding falhou p/ {it.get('numeroControlePNCP')}: {vec}")
                continue
            points.append({"id": pid, "vector": vec, "payload": _to_payload(it)})
            if pid not in existing:
                new_items.append(it)
                embedded_new += 1
        print(f"[PNCP-STORE] embeddings novos gerados: {embedded_new} "
              f"(reusados: {len(points) - embedded_new})")

        if not points:
            return {"upserted": 0, "new": 0, "new_items": []}

        resp = await client.put(
            f"{_QDRANT}/collections/{COLLECTION}/points?wait=true",
            json={"points": points},
        )
        resp.raise_for_status()

    return {"upserted": len(points), "new": len(new_items), "new_items": new_items}


# ─── Busca semântica local ───────────────────────────────────────────────────


async def search_local(
    query: str,
    *,
    uf: str | None = None,
    valor_min: float | None = None,
    valor_max: float | None = None,
    only_open: bool = True,
    min_dias_entrada: int | None = None,
    recentes_primeiro: bool = True,
    top_k: int = 8,
    min_score: float | None = None,
    controles: list[str] | None = None,
) -> list[PncpSource]:
    """Busca semântica instantânea no índice local de editais.

    Substitui o regex `_CATEGORY_HIERARCHY`: o usuário descreve em linguagem
    natural ('material de escritório', 'serviço de limpeza terceirizada') e o
    embedding acha os editais semanticamente próximos.

    Janela de entrada: por padrão só retorna oportunidades com folga de
    `min_dias_entrada` dias até o fim do recebimento (esconde os "em cima da
    hora"). Passe `min_dias_entrada=0` p/ incluir os de prazo curto (pedido
    explícito do usuário).

    `recentes_primeiro`: ordena por data de DIVULGAÇÃO no PNCP (mais novo
    primeiro), dentro dos relevantes ao tema.

    `controles` restringe a busca a um conjunto de numeroControlePNCP — usado
    pelos alertas para casar um perfil apenas contra os editais recém-chegados.
    """
    min_score = _MIN_SCORE if min_score is None else min_score
    min_dias_entrada = _MIN_DIAS_ENTRADA if min_dias_entrada is None else min_dias_entrada
    try:
        vector = await _embed(query)
    except Exception as e:
        print(f"[PNCP-STORE] embedding da query falhou: {e}")
        return []
    if not vector:
        return []

    must: list[dict] = []
    if uf:
        must.append({"key": "uf", "match": {"value": uf.upper()}})
    if only_open:
        # Cruza fim de recebimento com a folga mínima pra montar a proposta.
        cutoff = int(datetime.now(timezone.utc).timestamp()) + max(0, min_dias_entrada) * 86400
        must.append({"key": "encerra_epoch", "range": {"gte": cutoff}})
    if valor_min is not None:
        must.append({"key": "valor_num", "range": {"gte": valor_min}})
    if valor_max is not None:
        must.append({"key": "valor_num", "range": {"lte": valor_max}})
    if controles:
        must.append({"key": "numero_controle", "match": {"any": controles}})

    # Pool maior quando vamos reordenar por recência, p/ não perder os frescos.
    limit = max(top_k * 2, 12) if recentes_primeiro else top_k
    body: dict = {
        "vector": vector,
        "limit": limit,
        "with_payload": True,
        "score_threshold": min_score,
        "params": {"hnsw_ef": 128},
    }
    if must:
        body["filter"] = {"must": must}

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(
                f"{_QDRANT}/collections/{COLLECTION}/points/search", json=body
            )
            resp.raise_for_status()
        except Exception as e:
            print(f"[PNCP-STORE] search_local falhou: {e}")
            return []

    results = resp.json().get("result", [])
    # Prioriza os recém-divulgados entre os relevantes ao tema.
    if recentes_primeiro:
        results.sort(
            key=lambda p: p.get("payload", {}).get("divulgacao_epoch", 0),
            reverse=True,
        )
    return [_payload_to_source(p.get("payload", {})) for p in results[:top_k]]


async def _count_with(client: httpx.AsyncClient) -> int:
    try:
        resp = await client.post(
            f"{_QDRANT}/collections/{COLLECTION}/points/count", json={"exact": True}
        )
        resp.raise_for_status()
        return resp.json().get("result", {}).get("count", 0)
    except Exception:
        return 0


async def count() -> int:
    """Quantidade de editais indexados (0 = índice frio → usar fallback ao vivo)."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        return await _count_with(client)


async def prune_index() -> dict:
    """Faxina do índice (a "fila por tempo"): tira o que não serve mais.

    Remove:
    - recebimento JÁ ENCERRADO (encerra_epoch < agora) — não dá mais pra entrar;
    - parados há mais que o TTL (ingested_epoch < agora - PNCP_TTL_DIAS) — rede
      de segurança p/ órfãos (ex.: sem data de fim que nunca atualizaram).

    Returns:
        {"removidos_vencidos": int, "removidos_ttl": int, "restantes": int}
    """
    now = int(datetime.now(timezone.utc).timestamp())
    ttl_cutoff = now - _TTL_DIAS * 86400
    out = {"removidos_vencidos": 0, "removidos_ttl": 0, "restantes": 0}

    async with httpx.AsyncClient(timeout=30.0) as client:
        antes = await _count_with(client)

        # 1) Recebimento encerrado.
        try:
            r = await client.post(
                f"{_QDRANT}/collections/{COLLECTION}/points/delete?wait=true",
                json={"filter": {"must": [{"key": "encerra_epoch", "range": {"lt": now}}]}},
            )
            r.raise_for_status()
            meio = await _count_with(client)
            out["removidos_vencidos"] = max(0, antes - meio)
        except Exception as e:
            print(f"[PNCP-STORE] prune vencidos falhou: {e}")
            meio = antes

        # 2) TTL (órfãos antigos).
        try:
            r = await client.post(
                f"{_QDRANT}/collections/{COLLECTION}/points/delete?wait=true",
                json={"filter": {"must": [{"key": "ingested_epoch", "range": {"lt": ttl_cutoff}}]}},
            )
            r.raise_for_status()
            depois = await _count_with(client)
            out["removidos_ttl"] = max(0, meio - depois)
        except Exception as e:
            print(f"[PNCP-STORE] prune TTL falhou: {e}")
            depois = meio

        out["restantes"] = depois

    print(f"[PNCP-STORE] faxina: -{out['removidos_vencidos']} vencidos, "
          f"-{out['removidos_ttl']} TTL, restam {out['restantes']}")
    return out


__all__ = [
    "COLLECTION",
    "ensure_collection",
    "upsert_opportunities",
    "search_local",
    "count",
    "prune_index",
    "point_id",
]
