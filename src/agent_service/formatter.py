"""Formatação de respostas para WhatsApp."""

from __future__ import annotations

import re


def format_whatsapp_response(
    text: str,
    confidence: int = 80,
) -> str:
    """Formata a resposta para WhatsApp seguindo o estilo do Dr. IAGO.

    Aplica:
    - Remoção de markdown (**, ##, ```, etc.)
    - Formatação de moeda brasileira (R$ 1.234,56)
    - Remoção de emojis excessivos
    - Limite de 8000 caracteres
    - Normalização de whitespace
    """
    if not text:
        return ""

    t = text

    # MiniMax-M3 às vezes vaza blocos <think> e caracteres CJK na resposta
    # (refs: github.com/MiniMax-AI/MiniMax-M2/issues/100 e /55)
    t = re.sub(r"<think(?:ing)?\b[^>]*>[\s\S]*?</think(?:ing)?\s*>", "", t, flags=re.I)
    t = re.sub(r"<think(?:ing)?\b[^>]*>[\s\S]*$", "", t, flags=re.I)
    t = re.sub(
        "["
        "\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf"
        "\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f"
        "]+",
        "",
        t,
    )
    # caracteres invisiveis (zero-width, BOM)
    t = re.sub("[\u200b-\u200f\u2060\ufeff]", "", t)

    # Remove code blocks
    t = re.sub(r"```[\s\S]*?```", "", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)

    # Remove separadores decorativos
    t = re.sub(r"^\s*[-_*|=]{3,}\s*$", "", t, flags=re.MULTILINE)

    # Títulos markdown → texto simples
    t = re.sub(r"^#{1,6}\s+(.+)$", r"\1", t, flags=re.MULTILINE)

    # Remove ênfase (**texto**, __texto__, ||texto||)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"__(.+?)__", r"\1", t)
    t = re.sub(r"\|\|(.+?)\|\|", r"\1", t)

    # Itálico (*texto* ou _texto_) → texto simples
    t = re.sub(r"\*(.+?)\*", r"\1", t)
    t = re.sub(r"_([^_]+)_", r"\1", t)

    # Bullets: -*• → -
    t = re.sub(r"^[\s]*[-*•]\s+", "- ", t, flags=re.MULTILINE)

    # Citações: remove >
    t = re.sub(r"^>\s*", "", t, flags=re.MULTILINE)

    # Múltiplas quebras → no máximo 2
    t = re.sub(r"\n{3,}", "\n\n", t)

    # Linhas vazias com espaços
    t = re.sub(r"^[ \t]+$", "", t, flags=re.MULTILINE)

    # Espaços múltiplos → um espaço
    t = re.sub(r" {2,}", " ", t)

    # Colapsa espaços no início/fim de linha
    t = re.sub(r"[ \t]+\n", "\n", t)

    # Normaliza caracteres Unicode problemáticos
    t = t.normalize("NFC") if hasattr(t, "normalize") else t

    # Remove caracteres Unicode especiais que não aparecem no WhatsApp
    t = re.sub(r"[\u00a0\u202f]", " ", t)
    t = re.sub(r"[\ufffd]", "", t)
    t = re.sub(r"[\uD800-\uDFFF]", "", t)
    t = re.sub(r"[\u4e00-\u9fff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff"
               r"\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+", "", t)

    # Remove emojis (mantém no máximo 1 por parágrafo)
    t = re.sub(r"[\U0001F000-\U0001FAFF\U00002600-\U000027BF]", "", t)
    t = re.sub(r"[📌✅👍👎🤖✔✗🔔🔕🔵🔴🟢👇🎯⚠️]", "", t)

    # Remove asteriscos e underlines soltos
    t = re.sub(r"\*\*+", "", t)
    t = re.sub(r"__+", "", t)

    # Formata moeda — suporta múltiplos formatos vindos do LLM:
    #   "R$ 65,492,11"    → "R$ 65.492,11"  (vírgulas como milhar+decimal)
    #   "R$ 130.984,20"   → "R$ 130.984,20" (já correto)
    #   "R$ 130984.20"    → "R$ 130.984,20" (americano)
    #   "R$ 130984,20"    → "R$ 130.984,20" (sem milhar)
    #   "R$ 130984"       → "R$ 130.984,00"
    t = re.sub(
        r"R\$\s*([\d.,]+)",
        lambda m: _normalize_brl(m.group(1)),
        t,
    )

    t = t.strip()

    # Trunca se muito longo
    if len(t) > 8000:
        t = t[:7997] + "..."

    return t


def _format_brl(integer_part: str, cents_part: str | None) -> str:
    """Formata valor em reais: 130984 → R$ 130.984,00"""
    try:
        # Adiciona separadores de milhar
        int_str = str(int(integer_part))
        milhas = []
        while int_str:
            milhas.insert(0, int_str[-3:])
            int_str = int_str[:-3]
        formatted = ".".join(milhas)
        cents = cents_part if cents_part else "00"
        return f"R$ {formatted},{cents}"
    except (ValueError, TypeError):
        return f"R$ {integer_part},{cents_part or '00'}"


def _normalize_brl(raw: str) -> str:
    """Normaliza um valor monetário em qualquer formato vindo do LLM.

    Estratégia: extrai todos os dígitos, identifica os últimos 2 como
    centavos quando o formato sugere isso, e formata com ponto milhar.
    """
    s = raw.strip().rstrip(".,")
    if not s:
        return "R$ "

    # Conta separadores
    has_comma = "," in s
    has_dot = "." in s

    # Caso 1: só dígitos → sem decimal explícito
    if not has_comma and not has_dot:
        return _format_brl(s, None)

    # Identifica o ÚLTIMO separador (decimal) e tudo antes (milhar)
    last_sep_pos = max(s.rfind(","), s.rfind("."))
    last_sep = s[last_sep_pos]
    after_sep = s[last_sep_pos + 1:]

    # Se depois do último separador houver exatamente 2 dígitos → é decimal
    # Caso especial: "1.234.567" (3 separadores ponto idênticos) → SEM decimal
    if len(after_sep) == 2 and after_sep.isdigit():
        # Caso especial: "R$ 130.984" (1 separador, 3 dígitos depois) NÃO se
        # encaixa aqui pois len != 2.
        integer_digits = "".join(ch for ch in s[:last_sep_pos] if ch.isdigit())
        cents = after_sep
        if not integer_digits:
            integer_digits = "0"
        return _format_brl(integer_digits, cents)

    # Caso 3: separador é ponto único com 3 dígitos depois ("R$ 130.984") → milhar
    integer_digits = "".join(ch for ch in s if ch.isdigit())
    return _format_brl(integer_digits, None)


def strip_markdown(text: str) -> str:
    """Apenas remove markdown, sem outras formatações."""
    t = text
    t = re.sub(r"```[\s\S]*?```", "", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"__(.+?)__", r"\1", t)
    t = re.sub(r"\*(.+?)\*", r"\1", t)
    t = re.sub(r"_([^_]+)_", r"\1", t)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.MULTILINE)
    t = re.sub(r"^[\s]*[-*•]\s+", "- ", t, flags=re.MULTILINE)
    return t.strip()
