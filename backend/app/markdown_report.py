"""Render the prompt-directed Markdown report, including arbitrary tables, to a polished PDF.

The PDF shows the results only: header, date, model, scope metrics, the report
itself (summary, findings, tables in whatever shape the prompt asked for) and the
list of files reviewed. The review prompt's text is never printed.

Whatever layout the model returns, it is rendered consistently: branded
headings, zebra-striped tables whose rating cells (Critical/High/Medium/Low/Info,
Pass/Partial/Fail) are colour-coded, boxed code blocks in a monospaced face, and
page x of y footers. Model text is escaped; raw HTML and remote images are never
interpreted.
"""
from __future__ import annotations

import re
import textwrap
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import urlparse

from markdown_it import MarkdownIt
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (KeepTogether, LongTable, PageBreak, Paragraph, Preformatted,
                                SimpleDocTemplate, Spacer, Table, TableStyle)
from reportlab.platypus.flowables import CondPageBreak, HRFlowable, PageBreakIfNotEmpty

INK = colors.HexColor("#152638")
BRAND = colors.HexColor("#095499")
BRAND_DARK = colors.HexColor("#063A6B")
MUTED = colors.HexColor("#526375")
LINE = colors.HexColor("#DCE3EC")
PANEL = colors.HexColor("#F2F6FA")
CODE_BG = colors.HexColor("#F5F7FA")

RATING_COLORS = {
    "critical": "#A71930", "blocker": "#A71930",
    "high": "#C2410C", "major": "#C2410C",
    "medium": "#A16207", "moderate": "#A16207",
    "low": "#1768A4", "minor": "#1768A4",
    "info": "#607086", "informational": "#607086", "note": "#607086",
    "pass": "#1A7F4B", "passed": "#1A7F4B", "ok": "#1A7F4B", "good": "#1A7F4B", "yes": "#1A7F4B",
    "partial": "#A16207", "mixed": "#A16207",
    "fail": "#A71930", "failed": "#A71930", "no": "#A71930",
}
SEVERITY_ORDER = ("critical", "high", "medium", "low", "info")
SEVERITY_ALIAS = {"blocker": "critical", "major": "high", "moderate": "medium", "minor": "low",
                  "informational": "info", "note": "info"}
_EMOJI = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]")


def _mono_font() -> str:
    candidates = [
        Path(__file__).resolve().parents[1] / "assets" / "fonts" / "DejaVuSansMono.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        Path("C:/Windows/Fonts/consola.ttf"),
        Path("C:/Windows/Fonts/cour.ttf"),
        Path("/System/Library/Fonts/Supplemental/Courier New.ttf"),
        Path("/Library/Fonts/Courier New.ttf"),
    ]
    for path in candidates:
        if path.exists():
            try:
                if "QuCoReMono" not in pdfmetrics.getRegisteredFontNames():
                    pdfmetrics.registerFont(TTFont("QuCoReMono", str(path)))
                return "QuCoReMono"
            except Exception:  # noqa: BLE001 - a damaged system font must not break the report
                continue
    return "Courier"


def _rating(text: str) -> str | None:
    """'High', '**Critical**', '🔴 High', 'High risk' -> the rating word, else None."""
    plain = _EMOJI.sub("", re.sub(r"<[^>]*>", "", text)).replace("&amp;", "&").strip(" *_`.:-–—()[]").lower()
    if not plain:
        return None
    if plain in RATING_COLORS:
        return plain
    words = plain.split()
    if len(words) <= 2 and words[0] in RATING_COLORS and words[0] not in ("yes", "no", "ok", "good", "note"):
        return words[0]
    return None


def severity_counts(markdown: str, parser: MarkdownIt) -> dict[str, int]:
    """Count rating cells in the report's tables, whatever the table looks like."""
    counts = {name: 0 for name in SEVERITY_ORDER}
    inside_cell = False
    for token in parser.parse(markdown or ""):
        if token.type == "td_open":
            inside_cell = True
        elif token.type == "td_close":
            inside_cell = False
        elif inside_cell and token.type == "inline":
            word = _rating(token.content)
            word = SEVERITY_ALIAS.get(word, word)
            if word in counts:
                counts[word] += 1
    return counts


def _when(value: str) -> str:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        zone = stamp.strftime("%Z") or "UTC"
        return stamp.strftime("%d %b %Y, %H:%M ") + zone
    except ValueError:
        return str(value)


class NumberedCanvas(pdfcanvas.Canvas):
    """Two-pass canvas so each footer can say 'Page x of y'."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages: list[dict] = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self.saveState()
            self.setFont(getattr(self, "_qucore_font", "Helvetica"), 7)
            self.setFillColor(MUTED)
            self.drawRightString(self._pagesize[0] - 18 * mm, 11 * mm, f"Page {self._pageNumber} of {total}")
            self.restoreState()
            super().showPage()
        super().save()


def write_markdown_pdf(report, path):
    from .pdf_report import fonts
    regular, bold, unicode_font = fonts()
    mono = _mono_font()
    parser = MarkdownIt("commonmark").enable("table").enable("strikethrough")
    texts = [report["report_markdown"]]
    if len(report.get("batch_reports", [])) > 1:
        texts.extend(b["report_markdown"] for b in report["batch_reports"])
    # Wide user-defined tables get a landscape page; column names are never
    # replaced with a fixed QuCoRe template.
    max_columns = 0
    for text in texts:
        count = 0
        for token in parser.parse(text):
            if token.type == "tr_open":
                count = 0
            elif token.type in {"th_open", "td_open"}:
                count += 1
            elif token.type == "tr_close":
                max_columns = max(max_columns, count)
    pagesize = landscape(A4) if max_columns > 5 else A4
    width = pagesize[0] - 36 * mm
    band = 30 * mm

    base = ParagraphStyle("qBody", fontName=regular, fontSize=9.2, leading=14, textColor=INK, spaceAfter=7,
                          splitLongWords=True)
    styles = {
        "body": base,
        "small": ParagraphStyle("qSmall", parent=base, fontSize=7.8, leading=11, textColor=MUTED, spaceAfter=4),
        "label": ParagraphStyle("qLabel", parent=base, fontSize=7.4, leading=10, textColor=MUTED, spaceAfter=0),
        "meta": ParagraphStyle("qMeta", parent=base, fontSize=8.6, leading=12, spaceAfter=0),
        "tile": ParagraphStyle("qTile", parent=base, fontName=bold, fontSize=13.5, leading=18, spaceAfter=0),
        "h1": ParagraphStyle("qH1", parent=base, fontName=bold, fontSize=17, leading=22, textColor=BRAND_DARK,
                             spaceBefore=10, spaceAfter=8, keepWithNext=True),
        "h2": ParagraphStyle("qH2", parent=base, fontName=bold, fontSize=13.5, leading=18, textColor=BRAND,
                             spaceBefore=12, spaceAfter=4, keepWithNext=True),
        "h3": ParagraphStyle("qH3", parent=base, fontName=bold, fontSize=11, leading=15, textColor=INK,
                             spaceBefore=8, spaceAfter=4, keepWithNext=True),
        "h4": ParagraphStyle("qH4", parent=base, fontName=bold, fontSize=9.6, leading=13, textColor=INK,
                             spaceBefore=6, spaceAfter=3, keepWithNext=True),
        "quote": ParagraphStyle("qQuote", parent=base, textColor=MUTED, leftIndent=12, backColor=PANEL,
                                borderPadding=(5, 6, 5, 8)),
        "table": ParagraphStyle("qTable", parent=base, fontSize=8 if max_columns < 7 else 7, leading=11,
                                spaceAfter=0),
        "table_header": ParagraphStyle("qTableHeader", parent=base, fontName=bold, fontSize=8, leading=11,
                                       textColor=colors.white, spaceAfter=0),
        "code": ParagraphStyle("qCode", fontName=mono, fontSize=7.2, leading=10, textColor=INK),
    }

    def safe(text):
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", str(text))
        text = _EMOJI.sub("", text)  # PDF fonts carry no emoji glyphs; they would print as boxes
        if not unicode_font:
            text = text.translate(str.maketrans({"—": "-", "–": "-", "“": '"', "”": '"', "’": "'", "‘": "'",
                                                 "→": "->", "•": "-", "…": "..."}))
            text = text.encode("cp1252", "replace").decode("cp1252")
        return escape(text)

    def p(text, style="body"):
        return Paragraph(safe(text).replace("\n", "<br/>"), styles[style])

    def inline(children):
        out, link_stack = [], []
        for token in children or []:
            kind = token.type
            if kind in {"text", "code_inline"}:
                value = safe(token.content)
                out.append(f'<font face="{mono}" size="8">{value}</font>' if kind == "code_inline" else value)
            elif kind in {"softbreak", "hardbreak"}:
                out.append("<br/>" if kind == "hardbreak" else " ")
            elif kind in {"strong_open", "strong_close", "em_open", "em_close", "s_open", "s_close"}:
                out.append({"strong_open": "<b>", "strong_close": "</b>", "em_open": "<i>", "em_close": "</i>",
                            "s_open": "<strike>", "s_close": "</strike>"}[kind])
            elif kind == "link_open":
                href = token.attrGet("href") or ""
                allowed = urlparse(href).scheme.lower() in {"https", "http", "mailto"}
                link_stack.append(allowed)
                if allowed:
                    out.append(f'<link href="{escape(href, quote=True)}" color="#095499">')
            elif kind == "link_close":
                if link_stack and link_stack.pop():
                    out.append("</link>")
            elif kind == "image":
                out.append(safe(token.content))  # Never fetch remote resources.
            # Raw HTML is intentionally not interpreted or rendered.
        return "".join(out)

    def build_table(rows):
        cols = max(len(row) for row in rows)
        padded = [row + [""] * (cols - len(row)) for row in rows]
        def plain(cell):
            return re.sub("<[^>]*>", " ", cell).replace("&amp;", "&")
        weights = []
        for c in range(cols):
            longest_text = max(len(plain(row[c])) for row in padded[:40])
            longest_word = max((len(w) for row in padded[:40] for w in plain(row[c]).split()), default=0)
            # Never narrower than the longest word (so "Severity" or "Medium" is not broken).
            weights.append(min(60, max(10, longest_text, longest_word * 1.25 + 2)))
        total = sum(weights)
        widths = [width * w / total for w in weights]
        # Guarantee each column fits its longest word (bold, as rating cells are bold),
        # taking the space from the wider columns.
        size = styles["table"].fontSize
        minimum = []
        for c in range(cols):
            words = [w for row in padded[:60] for w in plain(row[c]).split()] or [" "]
            longest = max(max(pdfmetrics.stringWidth(w, bold, max(size, 8)),
                              pdfmetrics.stringWidth(w, mono, 8)) for w in words)
            minimum.append(min(width * .3, longest + 14))
        for _ in range(3):
            short = [c for c in range(cols) if widths[c] < minimum[c]]
            if not short:
                break
            need = sum(minimum[c] - widths[c] for c in short)
            donors = [c for c in range(cols) if c not in short and widths[c] > minimum[c]]
            spare = sum(widths[c] - minimum[c] for c in donors)
            if spare <= 0:
                break
            take = min(need, spare)
            for c in short:
                widths[c] += (minimum[c] - widths[c]) * take / need
            for c in donors:
                widths[c] -= (widths[c] - minimum[c]) * take / spare
        commands = [
            ("BACKGROUND", (0, 0), (-1, 0), BRAND_DARK),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, 0), (-1, -1), .4, LINE),
            ("BOX", (0, 0), (-1, -1), .5, LINE),
        ]
        table_rows = []
        for r, row in enumerate(padded):
            cells = []
            for c, cell in enumerate(row):
                if r == 0:
                    cells.append(Paragraph(cell or " ", styles["table_header"]))
                    continue
                word = _rating(cell)
                if word:
                    color = RATING_COLORS[word]
                    cells.append(Paragraph(f'<font color="{color}"><b>{cell}</b></font>', styles["table"]))
                    tint = colors.HexColor(color)
                    commands.append(("BACKGROUND", (c, r), (c, r), colors.Color(*tint.rgb(), alpha=0.10)))
                else:
                    cells.append(Paragraph(cell or " ", styles["table"]))
            table_rows.append(cells)
        table = LongTable(table_rows, colWidths=widths, repeatRows=1, splitByRow=1, splitInRow=1, hAlign="LEFT")
        table.setStyle(TableStyle(commands))
        return table

    def code_block(content):
        code = content if (unicode_font and mono != "Courier") else content.encode("cp1252", "replace").decode("cp1252")
        char = pdfmetrics.stringWidth("M", mono, 7.2) or 4.3
        columns = max(40, int((width - 20) / char))
        wrapped = "\n".join("\n".join(textwrap.wrap(line, width=columns, replace_whitespace=False,
                                                    drop_whitespace=False) or [""])
                            for line in code.rstrip("\n").splitlines())
        box = Table([[Preformatted(wrapped, styles["code"])]], colWidths=[width], hAlign="LEFT")
        box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), CODE_BG), ("BOX", (0, 0), (-1, -1), .5, LINE),
                                 ("LINEBEFORE", (0, 0), (0, -1), 2, BRAND),
                                 ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                                 ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        return box

    bullet = "•" if unicode_font else "-"

    def markdown(text):
        """Flowables for one Markdown report.

        Every top-level section (# / ##) after the first starts on a new page, so a
        heading can never be left at the bottom of a page with its content on the
        next. Sub-headings (### and deeper) move to the next page when too little
        space is left for the heading plus the start of its content.
        """
        tokens = parser.parse(text)
        story = []
        sections = 0
        i = 0
        list_stack = []
        pending_bullet = None
        heading = None
        quote = 0
        while i < len(tokens):
            token = tokens[i]
            if token.type == "table_open":
                rows, row, cells = [], [], []
                i += 1
                while i < len(tokens) and tokens[i].type != "table_close":
                    t = tokens[i]
                    if t.type == "tr_open":
                        row = []
                    elif t.type in {"th_open", "td_open"}:
                        cells = []
                    elif t.type == "inline":
                        cells.append(inline(t.children))
                    elif t.type in {"th_close", "td_close"}:
                        row.append("<br/>".join(cells))
                    elif t.type == "tr_close":
                        rows.append(row)
                    i += 1
                if rows:
                    story.extend([Spacer(1, 3), build_table(rows), Spacer(1, 10)])
            elif token.type in {"bullet_list_open", "ordered_list_open"}:
                list_stack.append([token.type == "ordered_list_open", int(token.attrGet("start") or 1)])
            elif token.type in {"bullet_list_close", "ordered_list_close"}:
                if list_stack:
                    list_stack.pop()
                if not list_stack:
                    story.append(Spacer(1, 3))
            elif token.type == "list_item_open":
                if list_stack:
                    ordered, number = list_stack[-1]
                    pending_bullet = f"{number}." if ordered else bullet
                    list_stack[-1][1] += 1
            elif token.type == "heading_open":
                heading = token.tag
                if heading in ("h1", "h2"):
                    if sections:
                        story.append(PageBreakIfNotEmpty())
                    sections += 1
                else:
                    story.append(CondPageBreak(130))
            elif token.type == "heading_close":
                if heading in ("h1", "h2"):
                    story.append(HRFlowable(width="100%", thickness=.6, color=LINE, spaceBefore=0, spaceAfter=6))
                heading = None
            elif token.type == "blockquote_open":
                quote += 1
            elif token.type == "blockquote_close":
                quote = max(0, quote - 1)
            elif token.type == "inline":
                if heading:
                    level = heading if heading in ("h1", "h2", "h3") else "h4"
                    story.append(Paragraph(inline(token.children), styles[level]))
                elif list_stack:
                    depth = min(len(list_stack), 6)
                    style = ParagraphStyle("qList", parent=styles["body"], leftIndent=depth * 14,
                                           bulletIndent=depth * 14 - 11, spaceAfter=3)
                    if pending_bullet:
                        story.append(Paragraph(inline(token.children), style, bulletText=pending_bullet))
                    else:
                        story.append(Paragraph(inline(token.children), style))
                    pending_bullet = None
                elif quote:
                    story.append(Paragraph(inline(token.children), styles["quote"]))
                else:
                    story.append(Paragraph(inline(token.children), styles["body"]))
            elif token.type in {"fence", "code_block"}:
                story.extend([code_block(token.content), Spacer(1, 8)])
            elif token.type == "hr":
                story.append(HRFlowable(width="100%", thickness=.6, color=LINE, spaceBefore=6, spaceAfter=8))
            i += 1
        return story

    metrics = report["metrics"]
    usage = metrics["usage"]
    cost = metrics["cost"]
    value = cost["total_usd"] if cost["total_usd"] is not None else cost["known_subtotal_usd"]
    workspace = report.get("workspace_name") or "Codebase"
    model = report.get("deployment", "")
    if report.get("provider_label"):
        model = f"{model}  ({report['provider_label']})"

    # ---- Header block: facts about the run, never the prompt ------------------------------
    meta_rows = [
        [p("Codebase", "label"), p(workspace, "meta"), p("Generated", "label"), p(_when(report["created_at"]), "meta")],
        [p("Model", "label"), p(model, "meta"), p("Scope", "label"),
         p(f"{metrics['files_reviewed']} files · {metrics['lines_reviewed']:,} lines · "
           f"{metrics['batches_completed']} batch{'es' if metrics['batches_completed'] != 1 else ''}", "meta")],
    ]
    meta = Table(meta_rows, colWidths=[width * .12, width * .38, width * .12, width * .38], hAlign="LEFT")
    meta.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                              ("LINEBELOW", (0, 0), (-1, 0), .4, LINE)]))

    money = f"${value:,.2f}" if value >= 1 else f"${value:.4f}"
    tiles_data = [
        (f"{metrics['files_reviewed']:,}", "Files reviewed"),
        (f"{metrics['lines_reviewed']:,}", "Lines reviewed"),
        (f"{usage['input_tokens']:,}", "Input tokens"),
        (f"{usage['output_tokens']:,}", "Output tokens"),
        (money + ("" if cost["complete"] else "*"), "Est. cost (USD)"),
    ]
    tile_w = width / len(tiles_data)
    tiles = Table([[p(v, "tile") for v, _ in tiles_data], [p(label, "label") for _, label in tiles_data]],
                  colWidths=[tile_w] * len(tiles_data), hAlign="LEFT")
    tiles.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("BOX", (0, 0), (-1, -1), .5, LINE),
                               ("LINEAFTER", (0, 0), (-2, -1), .5, LINE),
                               ("LEFTPADDING", (0, 0), (-1, -1), 9),
                               ("TOPPADDING", (0, 0), (-1, 0), 9), ("BOTTOMPADDING", (0, 0), (-1, 0), 0),
                               ("TOPPADDING", (0, 1), (-1, 1), 0), ("BOTTOMPADDING", (0, 1), (-1, 1), 8)]))

    story = [Spacer(1, band - 10 * mm), meta, Spacer(1, 10), tiles]

    counts = severity_counts(report["report_markdown"], parser)
    if sum(counts.values()):
        cells, commands = [], []
        present = [name for name in SEVERITY_ORDER if counts[name]]
        for index, name in enumerate(present):
            cells.append(Paragraph(f'<font color="white"><b>{name.upper()}  {counts[name]}</b></font>',
                                   styles["table"]))
            commands.append(("BACKGROUND", (index, 0), (index, 0), colors.HexColor(RATING_COLORS[name])))
        strip = Table([cells], colWidths=[width / len(present)] * len(present), hAlign="LEFT")
        strip.setStyle(TableStyle(commands + [("TOPPADDING", (0, 0), (-1, -1), 6),
                                              ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                                              ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
        story += [Spacer(1, 8), p("Ratings found in the report tables", "label"), Spacer(1, 3), strip]

    if report.get("summary_note"):
        note = Table([[p(report["summary_note"], "meta")]], colWidths=[width], hAlign="LEFT")
        note.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF7E6")),
                                  ("LINEBEFORE", (0, 0), (0, -1), 2, colors.HexColor("#A16207")),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 6),
                                  ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        story += [Spacer(1, 8), note]

    story += [Spacer(1, 14)]
    story.extend(markdown(report["report_markdown"]))

    # Original batch reports are kept in full; synthesis cannot silently remove them.
    if len(report.get("batch_reports", [])) > 1 and report.get("summary_status") != "batch_reports_only":
        for batch in report["batch_reports"]:
            story.extend([PageBreak(), p(f"Appendix · Batch {batch['number']} report", "h1"),
                          p(", ".join(batch["files"]), "small")])
            story.extend(markdown(batch["report_markdown"]))

    # Files reviewed (no hashes, no prompt, no run identifiers).
    rows = [[Paragraph("File", styles["table_header"]), Paragraph("Lines", styles["table_header"])]]
    for source in report["files"]:
        rows.append([Paragraph(safe(source["path"]), styles["table"]),
                     Paragraph(f"{source['lines']:,}", styles["table"])])
    files = LongTable(rows, colWidths=[width * .85, width * .15], repeatRows=1, hAlign="LEFT")
    files.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), BRAND_DARK),
                               ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
                               ("LINEBELOW", (0, 0), (-1, -1), .4, LINE), ("BOX", (0, 0), (-1, -1), .5, LINE),
                               ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.extend([PageBreakIfNotEmpty(), p("Files reviewed", "h2"),
                  HRFlowable(width="100%", thickness=.6, color=LINE, spaceAfter=6),
                  files, Spacer(1, 12), CondPageBreak(90), p("About this report", "h3"), p(report["review_limits"], "small")])
    if not cost["complete"]:
        story.append(p("* Cost is a known subtotal: some requests did not report usage.", "small"))
    story.append(p(cost["basis"], "small"))
    if not unicode_font:
        story.append(p("Unsupported PDF font characters may be replaced. The JSON report retains the original text.",
                       "small"))

    report_title = report.get("report_title", "Code Review Report")
    title = f"{report_title} · {workspace}"

    def footer(c):
        c.setStrokeColor(LINE)
        c.line(18 * mm, 15 * mm, pagesize[0] - 18 * mm, 15 * mm)
        c.setFont(regular, 7)
        c.setFillColor(MUTED)
        c.drawString(18 * mm, 11 * mm, f"QuCoRe · Generated {_when(report['created_at'])}")

    def first_page(c, doc):
        c._qucore_font = regular
        c.saveState()
        c.setFillColor(BRAND)
        c.rect(0, pagesize[1] - band, pagesize[0], band, stroke=0, fill=1)
        c.setFillColor(BRAND_DARK)
        c.rect(0, pagesize[1] - band, pagesize[0], 1.6 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(bold, 8.5)
        c.drawString(18 * mm, pagesize[1] - 10 * mm, "QUCORE  ·  QUICK CODE REVIEW")
        c.setFont(bold, 20)
        c.drawString(18 * mm, pagesize[1] - 20 * mm, report_title)
        c.setFont(regular, 9)
        c.setFillColor(colors.HexColor("#CFE2F5"))
        c.drawRightString(pagesize[0] - 18 * mm, pagesize[1] - 20 * mm, workspace[:60])
        footer(c)
        c.restoreState()

    def later_pages(c, doc):
        c._qucore_font = regular
        c.saveState()
        c.setFillColor(BRAND)
        c.rect(0, pagesize[1] - 8 * mm, pagesize[0], 8 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(bold, 7.5)
        c.drawString(18 * mm, pagesize[1] - 5.3 * mm, "QuCoRe")
        c.setFont(regular, 7.5)
        c.drawString(32 * mm, pagesize[1] - 5.3 * mm, report_title + " · " + workspace[:70])
        footer(c)
        c.restoreState()

    doc = SimpleDocTemplate(str(path), pagesize=pagesize, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=14 * mm, bottomMargin=22 * mm, title=title, author="QuCoRe",
                            subject=report.get("report_title", "Code review report"))
    doc.build(story, onFirstPage=first_page, onLaterPages=later_pages, canvasmaker=NumberedCanvas)
