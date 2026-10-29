"""Deterministic ReportLab layout; model text is escaped, never used as markup."""
from __future__ import annotations

from collections import Counter
from html import escape
from pathlib import Path
import unicodedata
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, LongTable

INK = colors.HexColor("#152638")
BLUE = colors.HexColor("#095499")
MUTED = colors.HexColor("#526375")
LINE = colors.HexColor("#DCE3EC")
BG = colors.HexColor("#F2F6FA")
SEVERITY = {"critical": "#A71930", "high": "#CA4532", "medium": "#A36A0B", "low": "#1768A4", "info": "#607086"}


def fonts():
    # Optional portable Unicode font files can be placed here by the user.
    asset = Path(__file__).resolve().parents[1] / "assets" / "fonts"
    candidates = [
        (asset / "DejaVuSans.ttf", asset / "DejaVuSans-Bold.ttf"),
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            if "QuCoRe" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("QuCoRe", str(regular)))
                pdfmetrics.registerFont(TTFont("QuCoReBold", str(bold)))
                pdfmetrics.registerFontFamily("QuCoRe", normal="QuCoRe", bold="QuCoReBold", italic="QuCoRe", boldItalic="QuCoReBold")
            return "QuCoRe", "QuCoReBold", True
    return "Helvetica", "Helvetica-Bold", False


def write_pdf(report: dict, target: Path):
    if report.get("format_version") == 2:
        from .markdown_report import write_markdown_pdf
        return write_markdown_pdf(report, target)
    regular, bold, unicode_font = fonts()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="BodyQ", fontName=regular, fontSize=9, leading=14, textColor=INK, spaceAfter=8, splitLongWords=True))
    styles.add(ParagraphStyle(name="SmallQ", parent=styles["BodyQ"], fontSize=7.5, leading=11, spaceAfter=3))
    styles.add(ParagraphStyle(name="MutedQ", parent=styles["SmallQ"], textColor=MUTED))
    styles.add(ParagraphStyle(name="TitleQ", fontName=bold, fontSize=27, leading=34, textColor=INK, spaceAfter=10))
    styles.add(ParagraphStyle(name="SectionQ", fontName=bold, fontSize=13, leading=19, textColor=BLUE, spaceBefore=15, spaceAfter=9, keepWithNext=True))
    styles.add(ParagraphStyle(name="CardQ", fontName=bold, fontSize=14, leading=21, alignment=TA_CENTER, textColor=INK))
    styles.add(ParagraphStyle(name="WhiteQ", parent=styles["SmallQ"], fontName=bold, textColor=colors.white))

    def text(value):
        value = str(value)
        value = "".join(c if c in "\n\t" or not unicodedata.category(c).startswith("C") else " " for c in value)
        if not unicode_font:
            value = value.translate(str.maketrans({"—": "-", "–": "-", "“": '"', "”": '"', "’": "'", "→": "->"}))
            value = value.encode("cp1252", "replace").decode("cp1252")
        return escape(value).replace("\n", "<br/>")

    def p(value, style="BodyQ"):
        return Paragraph(text(value), styles[style])

    def table(rows, widths, header=True):
        t = LongTable(rows, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT", splitByRow=1, splitInRow=1)
        commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7), ("LINEBELOW", (0, 0), (-1, -1), .4, LINE)]
        if header:
            commands.extend([("BACKGROUND", (0, 0), (-1, 0), INK), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BG])])
        t.setStyle(TableStyle(commands))
        return t

    width = A4[0] - 36 * mm
    story = []
    counts = Counter(f["severity"] for f in report["findings"])
    risk = next((s.upper() for s in SEVERITY if counts[s]), "NONE IDENTIFIED")
    story += [p("QUCORE  /  QUICK CODE REVIEW", "MutedQ"), Spacer(1, 5 * mm), p("Code review report", "TitleQ"), p(report["workspace_name"], "SectionQ"),
              p(f"{report['created_at']}", "MutedQ"),
              p(f"Workspace: {report['workspace_name']}\nDeployment: {report['deployment']}\nHighest reported severity: {risk}", "BodyQ")]
    cards = Table([[p(str(len(report["files"])), "CardQ"), p(str(len(report["findings"])), "CardQ"), p(str(len(report["strengths"])), "CardQ")],
                   [p("FILES REVIEWED", "MutedQ"), p("FINDINGS", "MutedQ"), p("STRENGTHS", "MutedQ")]], colWidths=[width / 3] * 3)
    cards.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), BG), ("BOX", (0, 0), (-1, -1), .6, LINE), ("TOPPADDING", (0, 0), (-1, 0), 12), ("BOTTOMPADDING", (0, -1), (-1, -1), 10), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    story += [Spacer(1, 4 * mm), cards, p("01  Executive summary", "SectionQ"), p(report["summary"])]
    # A labeled severity strip stays understandable without color.
    cells = [p(f"{name.upper()}\n{counts[name]}", "WhiteQ") for name in SEVERITY]
    strip = Table([cells], colWidths=[width / 5] * 5)
    strip.setStyle(TableStyle([( "BACKGROUND", (i, 0), (i, 0), colors.HexColor(color)) for i, color in enumerate(SEVERITY.values())] + [("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9)]))
    story += [Spacer(1, 2 * mm), strip, p("02  Findings register", "SectionQ")]
    if report["findings"]:
        rows = [[p(x, "WhiteQ") for x in ["ID / severity", "Finding", "Source"]]]
        for i, finding in enumerate(report["findings"], 1):
            rows.append([p(f"F{i:02d}\n{finding['severity'].upper()}", "SmallQ"), p(finding["title"], "SmallQ"), p(f"{finding['file']}\nLines {finding['line_start']}-{finding['line_end']}", "SmallQ")])
        story.append(table(rows, [width * .16, width * .48, width * .36]))
        for i, finding in enumerate(report["findings"], 1):
            story += [p(f"F{i:02d}  {finding['title']}", "SectionQ"), p(f"{finding['severity'].upper()} / {finding['category']} / {finding['file']}:{finding['line_start']}-{finding['line_end']}", "MutedQ")]
            for label, key in [("Evidence", "evidence"), ("Impact", "impact"), ("Recommendation", "recommendation")]:
                story.append(Paragraph(f"<b>{label}</b><br/>" + text(finding[key]), styles["BodyQ"]))
            story.append(p("Evidence quote matched the cited source." if finding["evidence_verified"] else "QUOTE NOT MATCHED - manually verify this finding against the source.", "MutedQ"))
    else:
        story.append(p("No actionable findings were identified under the selected prompt. This does not certify the code as defect-free."))
    story.append(p("03  What is working well", "SectionQ"))
    if report["strengths"]:
        rows = [[p(x, "WhiteQ") for x in ["Strength", "Evidence / explanation"]]]
        for strength in report["strengths"]:
            rows.append([p(strength["title"], "SmallQ"), p(f"{strength['file']}:{strength['line_start']}-{strength['line_end']}\n{strength['explanation']}", "SmallQ")])
        story.append(table(rows, [width * .32, width * .68]))
    else:
        story.append(p("The model did not identify specific strengths under this prompt."))
    story.append(p("04  Recommended next steps", "SectionQ"))
    for i, item in enumerate(report["next_steps"], 1):
        story.append(p(f"{i}. {item}"))
    if not report["next_steps"]:
        story.append(p("No additional next steps were proposed."))
    story.append(p("05  Scope and limitations", "SectionQ"))
    for limitation in report["limitations"]:
        story.append(p("- " + limitation))
    story += [p(f"Semantic ordering: {'enabled (all selected files retained)' if report['embeddings']['enabled'] else 'disabled'}", "MutedQ"),
              p(f"Largest planned review request (conservative input): {report['budget']['input_token_upper_bound']:,} tokens. Reserved output per request: {report['budget']['reserved_output_tokens']:,} tokens.", "MutedQ")]
    strategy = report.get("review_strategy")
    if strategy:
        story.append(p(
            f"Review strategy: sequential files/chunks. {strategy['files_reviewed']} files, "
            f"{strategy['chunks_reviewed']} chunks. Summary status: {strategy['summary_status']}. "
            f"Summary requests: {strategy['summary_requests']}.", "MutedQ"))
        if strategy["summary_status"] != "completed":
            story.append(p("AUTOMATIC SYNTHESIS UNAVAILABLE: the executive summary is a deterministic coverage summary. Detailed review findings are preserved.", "BodyQ"))
    if not unicode_font:
        story.append(p("Font note: unsupported characters were replaced for PDF display. The JSON report preserves original Unicode text.", "MutedQ"))
    # The review prompt is never printed; only the files that were reviewed.
    story += [p("Appendix  Files reviewed", "SectionQ")]
    rows = [[p(x, "WhiteQ") for x in ["File", "Lines"]]]
    for source in report["files"]:
        rows.append([p(source["path"], "SmallQ"), p(f"{source['lines']:,}", "SmallQ")])
    story.append(table(rows, [width * .82, width * .18]))

    def page(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(18 * mm, 17 * mm, A4[0] - 18 * mm, 17 * mm)
        canvas.setFont(regular, 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, 12 * mm, "QuCoRe / Code review report")
        canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(str(target), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
                            topMargin=17 * mm, bottomMargin=24 * mm, title="QuCoRe - Code review report", author="QuCoRe")
    doc.build(story, onFirstPage=page, onLaterPages=page)
