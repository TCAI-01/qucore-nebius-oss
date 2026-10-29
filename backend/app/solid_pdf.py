"""PDF report for a Solidify design review.

Same visual family as the review PDF: branded cover band, KPI tiles, a scorecard with
a radar chart and score bars (drawn with reportlab graphics), the executive summary,
architecture overview, design patterns, class inventory, dependency analysis, every
finding (problem, why it matters, evidence, fix steps, before/after code and the
runnable demonstration), the improvement roadmap and an appendix.

Model text is escaped; raw HTML and remote resources are never interpreted.
"""
from __future__ import annotations

import io
import math
import re
import textwrap
from html import escape

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (CondPageBreak, KeepTogether, LongTable, PageBreak, Paragraph, Preformatted,
                                SimpleDocTemplate, Spacer, Table, TableStyle)
from reportlab.platypus.flowables import HRFlowable

from .markdown_report import BRAND, BRAND_DARK, CODE_BG, INK, LINE, MUTED, PANEL, NumberedCanvas, _EMOJI, _mono_font, _when
from .pdf_report import fonts
from .solid_metrics import GROUP_INFO, PRINCIPLE_INFO, SEVERITIES

SEV_COLOR = {"critical": "#B42318", "high": "#C2410C", "medium": "#A16207", "low": "#1D6FB8", "info": "#607086"}
RED = colors.HexColor("#B42318")
GREEN = colors.HexColor("#1A7F4B")
AMBER = colors.HexColor("#A16207")
CODE_CHUNK = 46          # code lines per box, so a box never exceeds a page


def _score_color(score) -> colors.Color:
    if score is None:
        return MUTED
    return GREEN if score >= 80 else AMBER if score >= 65 else RED


def _money(value) -> str:
    if value is None:
        return "n/a"
    return f"${value:,.2f}" if value >= 1 else f"${value:.4f}"


def write_solid_pdf(job: dict) -> bytes:
    regular, bold, unicode_font = fonts()
    mono = _mono_font()
    report = job.get("report") or {}
    pagesize = A4
    width = pagesize[0] - 36 * mm
    band = 30 * mm

    base = ParagraphStyle("dBody", fontName=regular, fontSize=9.2, leading=14, textColor=INK, spaceAfter=6, splitLongWords=True)
    styles = {
        "body": base,
        "small": ParagraphStyle("dSmall", parent=base, fontSize=7.8, leading=11, textColor=MUTED, spaceAfter=3),
        "label": ParagraphStyle("dLabel", parent=base, fontSize=7.4, leading=10, textColor=MUTED, spaceAfter=0),
        "meta": ParagraphStyle("dMeta", parent=base, fontSize=8.6, leading=12, spaceAfter=0),
        "tile": ParagraphStyle("dTile", parent=base, fontName=bold, fontSize=14, leading=18, spaceAfter=0),
        "section": ParagraphStyle("dSection", parent=base, fontName=bold, fontSize=14, leading=19, textColor=BRAND,
                                  spaceBefore=8, spaceAfter=4, keepWithNext=True),
        "h3": ParagraphStyle("dH3", parent=base, fontName=bold, fontSize=10.2, leading=14, spaceBefore=6, spaceAfter=3,
                             keepWithNext=True),
        "h4": ParagraphStyle("dH4", parent=base, fontName=bold, fontSize=8.8, leading=12, textColor=BRAND_DARK,
                             spaceBefore=5, spaceAfter=2, keepWithNext=True),
        "ftitle": ParagraphStyle("dFTitle", parent=base, fontName=bold, fontSize=10.4, leading=14, spaceAfter=1),
        "table": ParagraphStyle("dTable", parent=base, fontSize=7.8, leading=10.5, spaceAfter=0),
        "table_header": ParagraphStyle("dTableHeader", parent=base, fontName=bold, fontSize=7.8, leading=10.5,
                                       textColor=colors.white, spaceAfter=0),
        "code": ParagraphStyle("dCode", fontName=mono, fontSize=7, leading=9.6, textColor=INK),
        "chip": ParagraphStyle("dChip", parent=base, fontName=bold, fontSize=9, leading=12, textColor=colors.white,
                               alignment=1, spaceAfter=0),
    }

    def safe(text) -> str:
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", str(text if text is not None else ""))
        text = _EMOJI.sub("", text)
        if not unicode_font:
            text = text.translate(str.maketrans({"—": "-", "–": "-", "“": '"', "”": '"', "’": "'", "‘": "'",
                                                 "→": "->", "•": "-", "…": "...", "↔": "<->"}))
            text = text.encode("cp1252", "replace").decode("cp1252")
        return escape(text)

    def p(text, style="body") -> Paragraph:
        return Paragraph(safe(text).replace("\n", "<br/>"), styles[style])

    def bullets(items, style="body") -> list:
        return [Paragraph(safe(item), ParagraphStyle("dBullet", parent=styles[style], leftIndent=13, bulletIndent=2,
                                                     spaceAfter=2.5), bulletText="•" if unicode_font else "-")
                for item in items]

    def numbered(items) -> list:
        return [Paragraph(safe(item), ParagraphStyle("dNum", parent=base, leftIndent=15, bulletIndent=0, spaceAfter=2.5),
                          bulletText=f"{n}.") for n, item in enumerate(items, 1)]

    def table(rows, weights, header=True, font_mono_cols=()) -> LongTable:
        total = sum(weights)
        widths = [width * w / total for w in weights]
        out = []
        for r, row in enumerate(rows):
            cells = []
            for c, cell in enumerate(row):
                if isinstance(cell, Paragraph):
                    cells.append(cell)
                elif header and r == 0:
                    cells.append(Paragraph(safe(cell) or " ", styles["table_header"]))
                elif c in font_mono_cols:
                    cells.append(Paragraph(f'<font face="{mono}" size="7.2">{safe(cell)}</font>', styles["table"]))
                else:
                    cells.append(Paragraph(safe(cell) or " ", styles["table"]))
            out.append(cells)
        result = LongTable(out, colWidths=widths, repeatRows=1 if header else 0, splitByRow=1, hAlign="LEFT")
        commands = [("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, PANEL]),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 4.5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5), ("LINEBELOW", (0, 0), (-1, -1), .4, LINE),
                    ("BOX", (0, 0), (-1, -1), .5, LINE)]
        if header:
            commands.append(("BACKGROUND", (0, 0), (-1, 0), BRAND_DARK))
        result.setStyle(TableStyle(commands))
        return result

    def code_boxes(code: str, accent, label: str | None = None) -> list:
        """Code in boxes of at most CODE_CHUNK lines (a single cell cannot split across pages)."""
        code = code if (unicode_font and mono != "Courier") else code.encode("cp1252", "replace").decode("cp1252")
        char = pdfmetrics.stringWidth("M", mono, 7) or 4.2
        columns = max(40, int((width - 24) / char))
        lines = []
        for line in code.rstrip("\n").split("\n"):
            lines.extend(textwrap.wrap(line, width=columns, replace_whitespace=False, drop_whitespace=False,
                                       subsequent_indent="    ") or [""])
        out = []
        if label:
            out.append(Paragraph(f'<font color="{accent.hexval().replace("0x", "#")}">{safe(label)}</font>', styles["h4"]))
        for start in range(0, len(lines), CODE_CHUNK):
            chunk = "\n".join(lines[start:start + CODE_CHUNK])
            box = Table([[Preformatted(chunk, styles["code"])]], colWidths=[width], hAlign="LEFT")
            box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), CODE_BG), ("BOX", (0, 0), (-1, -1), .5, LINE),
                                     ("LINEBEFORE", (0, 0), (0, -1), 2.4, accent), ("LEFTPADDING", (0, 0), (-1, -1), 9),
                                     ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 5),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
            out.append(box)
        out.append(Spacer(1, 5))
        return out

    # ------------------------------------------------------------- drawings ----
    def bars(items, span, label_w=118, bar_h=10, gap=7) -> Drawing:
        """items: (label, value 0-100 or None, color, right text)."""
        height = max(1, len(items)) * (bar_h + gap)
        d = Drawing(span, height)
        track = span - label_w - 46
        for i, (label, value, color, right) in enumerate(items):
            y = height - (i + 1) * (bar_h + gap) + gap / 2
            d.add(String(0, y + 2, label[:30], fontName=regular, fontSize=7.6, fillColor=INK))
            d.add(Rect(label_w, y, track, bar_h, fillColor=PANEL, strokeColor=LINE, strokeWidth=.3))
            if value is not None:
                d.add(Rect(label_w, y, track * max(0, min(value, 100)) / 100, bar_h, fillColor=color, strokeColor=None))
            d.add(String(label_w + track + 6, y + 2, right, fontName=bold, fontSize=7.8, fillColor=INK))
        return d

    def radar(items, size=200) -> Drawing:
        n = len(items)
        d = Drawing(size, size)
        cx = cy = size / 2
        radius = size / 2 - 52

        def point(i, fraction):
            angle = math.pi / 2 - 2 * math.pi * i / n
            return cx + radius * fraction * math.cos(angle), cy + radius * fraction * math.sin(angle)

        for ring in (.25, .5, .75, 1.0):
            flat = [c for i in range(n) for c in point(i, ring)]
            d.add(Polygon(flat, fillColor=None, strokeColor=LINE, strokeWidth=.6))
        for i in range(n):
            x, y = point(i, 1.0)
            d.add(Line(cx, cy, x, y, strokeColor=LINE, strokeWidth=.4))
        flat = [c for i, (_, value) in enumerate(items) for c in point(i, max(0.02, (value or 0) / 100))]
        d.add(Polygon(flat, fillColor=colors.Color(*BRAND.rgb(), alpha=0.22), strokeColor=BRAND, strokeWidth=1.4))
        for i, (label, value) in enumerate(items):
            x, y = point(i, 1.0)
            angle = math.pi / 2 - 2 * math.pi * i / n
            lx, ly = cx + (radius + 9) * math.cos(angle), cy + (radius + 9) * math.sin(angle)
            anchor = "middle" if abs(math.cos(angle)) < .25 else ("start" if math.cos(angle) > 0 else "end")
            d.add(String(lx, ly - 3 + (4 if math.sin(angle) > .6 else -4 if math.sin(angle) < -.6 else 0),
                         f"{label} {value if value is not None else '-'}", fontName=regular, fontSize=7.4,
                         fillColor=INK, textAnchor=anchor))
        return d

    # ---------------------------------------------------------------- cover ----
    usage, cost, counts = job.get("usage") or {}, job.get("cost") or {}, job.get("counts") or {}
    overall = report.get("overall") or {}
    findings = report.get("findings") or []
    cost_value = cost.get("total_usd") if cost.get("total_usd") is not None else cost.get("known_subtotal_usd")
    workspace = job.get("workspace_name") or "Codebase"
    model = job.get("deployment") or ""
    if job.get("provider_label"):
        model = f"{model}  ({job['provider_label']})"

    meta = Table([[p("Review", "label"), p(job.get("title") or "", "meta"), p("Generated", "label"), p(_when(job.get("created_at", "")), "meta")],
                  [p("Codebase", "label"), p(workspace, "meta"), p("Model", "label"), p(model, "meta")]],
                 colWidths=[width * .12, width * .38, width * .12, width * .38], hAlign="LEFT")
    meta.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                              ("LINEBELOW", (0, 0), (-1, 0), .4, LINE)]))
    tiles_data = [
        (f"{overall.get('score', '-')}/100  {overall.get('grade', '')}", "Design score"),
        (f"{len(findings)}", f"Findings ({(report.get('severity_counts') or {}).get('critical', 0)} critical)"),
        (f"{counts.get('files', 0)} · {counts.get('lines', 0):,}", "Files · lines"),
        (f"{usage.get('input_tokens', 0):,} / {usage.get('output_tokens', 0):,}", "Tokens in / out"),
        (_money(cost_value) + ("" if cost.get("complete") else "*"), "Est. cost (USD)"),
    ]
    tile_w = width / len(tiles_data)
    tiles = Table([[Paragraph(safe(v), ParagraphStyle("dTileV", parent=styles["tile"],
                                                      textColor=_score_color(overall.get("score")) if i == 0 else INK))
                    for i, (v, _) in enumerate(tiles_data)],
                   [p(label, "label") for _, label in tiles_data]], colWidths=[tile_w] * len(tiles_data), hAlign="LEFT")
    tiles.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("BOX", (0, 0), (-1, -1), .5, LINE),
                               ("LINEAFTER", (0, 0), (-2, -1), .5, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 8),
                               ("TOPPADDING", (0, 0), (-1, 0), 9), ("BOTTOMPADDING", (0, 0), (-1, 0), 0),
                               ("TOPPADDING", (0, 1), (-1, 1), 0), ("BOTTOMPADDING", (0, 1), (-1, 1), 8)]))
    story = [Spacer(1, band - 10 * mm), meta, Spacer(1, 10), tiles]
    if job.get("error") or report.get("partial"):
        text = job.get("error") or "Partial review: some parts of the code were not reviewed."
        note = Table([[p(text, "meta")]], colWidths=[width], hAlign="LEFT")
        note.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF7E6")),
                                  ("LINEBEFORE", (0, 0), (0, -1), 2, AMBER), ("LEFTPADDING", (0, 0), (-1, -1), 9),
                                  ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        story += [Spacer(1, 8), note]

    def section(title):
        return [CondPageBreak(90), p(title, "section"), HRFlowable(width="100%", thickness=.6, color=LINE, spaceAfter=6)]

    # ----------------------------------------------------- summary + scorecard ----
    story += section("Executive summary")
    story.append(p(report.get("executive_summary") or "No summary was produced."))
    groups = report.get("groups") or []
    evaluated = [g for g in groups if g.get("evaluated")]
    if evaluated:
        story += section("Scorecard")
        radar_items = [(g["short"], g["score"]) for g in evaluated]
        group_bars = [(g["label"], g["score"], _score_color(g["score"]), f"{g['score']}  ({g['findings']})") for g in evaluated]
        left = radar(radar_items, 250) if len(radar_items) >= 3 else p("Radar needs at least three focus areas.", "small")
        right = bars(group_bars, width - 262, label_w=112)
        card = Table([[left, right]], colWidths=[262, width - 262], hAlign="LEFT")
        card.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        story += [card, p("Score = 100 / (1 + severity-weighted findings / size factor). Findings in brackets. "
                          "Critical 18, high 10, medium 5, low 2, info 0.", "small")]
        severity_counts = report.get("severity_counts") or {}
        present = [(s, severity_counts.get(s, 0)) for s in SEVERITIES if severity_counts.get(s)]
        if present:
            cells = [Paragraph(f'<font color="white"><b>{s.title()}  {n}</b></font>', styles["table"]) for s, n in present]
            strip = Table([cells], colWidths=[width / len(present)] * len(present), hAlign="LEFT")
            strip.setStyle(TableStyle([("BACKGROUND", (i, 0), (i, 0), colors.HexColor(SEV_COLOR[s])) for i, (s, _) in enumerate(present)]
                                      + [("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                                         ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
            story += [Spacer(1, 6), p("Findings by severity", "label"), Spacer(1, 3), strip]
        rows = [["Principle", "Area", "Findings", "Score"]]
        for item in report.get("principles") or []:
            rows.append([item["label"], GROUP_INFO[item["group"]]["short"], str(item["findings"]), str(item["score"])])
        story += [Spacer(1, 8), p("Score by principle", "h3"), table(rows, [38, 22, 14, 14])]

    if report.get("strengths_summary") or report.get("strengths"):
        story += section("What the code does well")
        story += bullets(report.get("strengths_summary") or [s["title"] + ": " + s["explanation"] for s in report["strengths"][:8]])

    # --------------------------------------------------------- architecture ----
    arch = report.get("architecture") or {}
    if arch.get("description") or arch.get("layers"):
        story += section("Architecture overview (HLD)")
        if arch.get("style"):
            story.append(p(f"Style: {arch['style']}", "h3"))
        story.append(p(arch.get("description", "")))
        if arch.get("layers"):
            rows = [["Layer", "Responsibility", "Files"]] + [[l["name"], l["responsibility"], ", ".join(l["files"][:6])] for l in arch["layers"]]
            story += [table(rows, [20, 40, 40], font_mono_cols=(2,)), Spacer(1, 6)]
        if arch.get("data_flow"):
            story += [p("Data flow, input to output", "h3")] + numbered(arch["data_flow"])
        if arch.get("concerns"):
            story += [p("Architecture concerns", "h3")] + bullets(arch["concerns"])

    # -------------------------------------------- patterns, classes, deps ----
    patterns = report.get("pattern_summary") or []
    if patterns or report.get("patterns"):
        story += section("Design patterns")
        if report.get("patterns"):
            rows = [["Pattern", "Type", "Status", "Where / note"]] + [
                [x["name"], x["category"].title(), x["status"].title(), (", ".join(x["files"][:3]) + ("  " if x["files"] else "") + x["note"]).strip()]
                for x in report["patterns"][:24]]
            story.append(table(rows, [18, 14, 13, 55]))
        if patterns:
            story += [p("Recommendations", "h3")] + bullets([f"{x['pattern']} ({x['status']}): {x['recommendation']}" for x in patterns])
    if report.get("classes"):
        story += section("Class and module inventory")
        rows = [["Name", "Kind", "File", "Responsibility", "Relations"]]
        for c in report["classes"][:45]:
            rows.append([c["name"], c["kind"], c["file"], c["responsibility"],
                         ", ".join(f"{r['type']} {r['target']}" for r in c["relations"][:4])])
        story.append(table(rows, [16, 9, 24, 33, 18], font_mono_cols=(2,)))
    deps = (report.get("metrics") or {}).get("dependencies") or {}
    if deps.get("supported"):
        story += section("Dependency analysis")
        cycles = deps.get("cycles") or []
        story.append(p(f"{deps.get('edges', 0)} import links between the reviewed files. "
                       + (f"{len(cycles)} circular dependency group(s) found." if cycles else "No circular dependencies found.")))
        for cycle in cycles[:6]:
            story += bullets([" ↔ ".join(cycle)])
        if deps.get("nodes"):
            rows = [["File", "Imported by", "Imports"]] + [[n["path"], str(n["fan_in"]), str(n["fan_out"])] for n in deps["nodes"][:15]]
            story += [Spacer(1, 4), table(rows, [70, 15, 15], font_mono_cols=(0,))]

    # -------------------------------------------------------------- findings ----
    if findings:
        story += [PageBreak(), p("Findings and proposed solutions", "section"),
                  HRFlowable(width="100%", thickness=.6, color=LINE, spaceAfter=6)]
    for finding in findings:
        sev = finding["severity"]
        chip = Paragraph(safe(finding["id"]), styles["chip"])
        title = [Paragraph(safe(finding["title"]), styles["ftitle"]),
                 Paragraph(safe(f"{sev.title()}  ·  {finding['principle_label']}  ·  "
                                f"{GROUP_INFO[finding['group']]['short']}  ·  effort {finding['effort']}"), styles["small"])]
        head = Table([[chip, title]], colWidths=[34, width - 34], hAlign="LEFT")
        head.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, 0), colors.HexColor(SEV_COLOR[sev])), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                  ("BACKGROUND", (1, 0), (1, 0), PANEL), ("BOX", (0, 0), (-1, -1), .5, LINE),
                                  ("LEFTPADDING", (1, 0), (1, 0), 9), ("TOPPADDING", (0, 0), (-1, -1), 6),
                                  ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
        where = (finding["file"] or "Project-wide") + (f":{finding['line_start']}-{finding['line_end']}" if finding["file"] else "")
        if finding.get("symbol"):
            where += f"  ({finding['symbol']})"
        block = [CondPageBreak(150), head, Spacer(1, 4),
                 Paragraph(f'<font face="{mono}" size="7.6" color="#063A6B">{safe(where)}</font>', styles["body"]),
                 p("Problem", "h4"), p(finding["problem"])]
        if finding.get("why_it_matters"):
            block += [p("Why it matters", "h4"), p(finding["why_it_matters"])]
        if finding.get("evidence"):
            block += code_boxes(finding["evidence"], MUTED, "Evidence")
        if finding.get("fix_steps"):
            block += [p("How to fix it" + (f"  ·  pattern: {finding['suggested_pattern']}" if finding.get("suggested_pattern") else ""), "h4")]
            block += numbered(finding["fix_steps"])
        if finding.get("occurrences"):
            block += [p("Also seen in", "h4"), p(", ".join(finding["occurrences"]), "small")]
        if finding.get("before_code"):
            block += code_boxes(finding["before_code"], RED, "Current code")
        if finding.get("after_code"):
            block += code_boxes(finding["after_code"], GREEN, "Proposed code")
        if finding.get("runnable_python"):
            runtime = "Node.js" if finding.get("demo_runtime") == "node" else "Python"
            block += code_boxes(finding["runnable_python"], BRAND, f"Runnable demonstration ({runtime}; run it in the QuSolids sandbox)")
        story += block + [Spacer(1, 8)]

    # --------------------------------------------------------------- roadmap ----
    if report.get("roadmap"):
        story += section("Improvement roadmap")
        for number, phase in enumerate(report["roadmap"], 1):
            story.append(KeepTogether([p(f"{number}. {phase['phase']}", "h3"), p(phase["goal"])]
                                      + bullets(phase["actions"])
                                      + ([p("Findings: " + ", ".join(phase["finding_ids"]), "small")] if phase["finding_ids"] else [])))
    if report.get("uml_recommendations"):
        story += section("Recommended UML and modelling")
        story += bullets([f"{u['diagram']}: {u['why']} Scope: {u['scope']}" for u in report["uml_recommendations"]])

    # -------------------------------------------------------------- appendix ----
    metrics = (report.get("metrics") or {}).get("files") or []
    if metrics:
        story += section("Appendix: structure metrics")
        rows = [["File", "Lines", "Classes", "Functions", "Largest symbol", "God classes"]]
        for m in sorted(metrics, key=lambda x: -x["lines"])[:60]:
            big = m.get("largest")
            rows.append([m["path"], str(m["lines"]), str(m["classes"]), str(m["functions"]),
                         f"{big['name']} ({big['lines']})" if big else "-", str(len(m["god_classes"]))])
        story.append(table(rows, [34, 9, 11, 14, 21, 11], font_mono_cols=(0,)))
    coverage = report.get("coverage") or {}
    if coverage.get("not_reviewed"):
        story += [p("Not reviewed", "h3"), p(", ".join(coverage["not_reviewed"][:40]), "small")]
    if report.get("notes"):
        story += [p("Assumptions and limitations", "h3")] + bullets(report["notes"], "small")
    story += [Spacer(1, 10), CondPageBreak(60), HRFlowable(width="100%", thickness=.6, color=LINE, spaceAfter=6),
              p("About this report", "h4"),
              p("Findings were produced by a language model from the code supplied and tool-computed structure facts. "
                "Scores are calculated from the findings. Nothing in your codebase was executed; runnable demonstrations "
                "are miniature illustrations of the proposed design. Review every change before applying it. "
                + str(cost.get("basis") or ""), "small")]

    title = f"Solidify design review · {workspace}"

    def footer(c):
        c.setStrokeColor(LINE)
        c.line(18 * mm, 15 * mm, pagesize[0] - 18 * mm, 15 * mm)
        c.setFont(regular, 7)
        c.setFillColor(MUTED)
        c.drawString(18 * mm, 11 * mm, f"QuCoRe Solidify · Generated {_when(job.get('created_at', ''))}")

    def first_page(c, doc):
        c._qucore_font = regular
        c.saveState()
        c.setFillColor(BRAND)
        c.rect(0, pagesize[1] - band, pagesize[0], band, stroke=0, fill=1)
        c.setFillColor(BRAND_DARK)
        c.rect(0, pagesize[1] - band, pagesize[0], 1.6 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(bold, 8.5)
        c.drawString(18 * mm, pagesize[1] - 10 * mm, "QUCORE  ·  SOLIDIFY")
        c.setFont(bold, 20)
        c.drawString(18 * mm, pagesize[1] - 20 * mm, "Design Quality Review")
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
        c.drawString(32 * mm, pagesize[1] - 5.3 * mm, "Solidify design review · " + workspace[:70])
        footer(c)
        c.restoreState()

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=pagesize, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=14 * mm,
                            bottomMargin=22 * mm, title=title, author="QuCoRe", subject="Design quality review")
    doc.build(story, onFirstPage=first_page, onLaterPages=later_pages, canvasmaker=NumberedCanvas)
    return buffer.getvalue()
