// api/generate.js — Vercel Serverless Function
// Handles: search Notion for kickoff + template → call Claude → save feedback to Notion

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ─── NOTION HELPERS ───────────────────────────────────────────────

async function notionSearch(query) {
  const r = await fetch(`${NOTION_API}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 5,
    }),
  });
  return r.json();
}

async function notionGetBlocks(pageId) {
  let allBlocks = [];
  let cursor;
  do {
    const url = `${NOTION_API}/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    const data = await r.json();
    allBlocks = allBlocks.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return allBlocks;
}

function blocksToText(blocks, depth = 0) {
  let text = "";
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    const richTexts = b[b.type]?.rich_text || [];
    const line = richTexts.map((t) => t.plain_text).join("");
    switch (b.type) {
      case "heading_1":
        text += `\n# ${line}\n`;
        break;
      case "heading_2":
        text += `\n## ${line}\n`;
        break;
      case "heading_3":
        text += `\n### ${line}\n`;
        break;
      case "paragraph":
        text += `${indent}${line}\n`;
        break;
      case "bulleted_list_item":
        text += `${indent}- ${line}\n`;
        break;
      case "numbered_list_item":
        text += `${indent}1. ${line}\n`;
        break;
      case "to_do":
        text += `${indent}[${b.to_do?.checked ? "x" : " "}] ${line}\n`;
        break;
      case "toggle":
        text += `${indent}▸ ${line}\n`;
        break;
      case "table_row":
        const cells = (b.table_row?.cells || [])
          .map((c) => c.map((t) => t.plain_text).join(""))
          .join(" | ");
        text += `${indent}| ${cells} |\n`;
        break;
      case "callout":
        const calloutText = richTexts.map((t) => t.plain_text).join("");
        text += `${indent}> ${calloutText}\n`;
        break;
      case "divider":
        text += `---\n`;
        break;
      default:
        if (line) text += `${indent}${line}\n`;
    }
  }
  return text;
}

async function getPageContent(pageId) {
  const pageR = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  const page = await pageR.json();
  const title =
    page.properties?.title?.title?.[0]?.plain_text ||
    page.properties?.Name?.title?.[0]?.plain_text ||
    Object.values(page.properties || {}).find((p) => p.type === "title")
      ?.title?.[0]?.plain_text ||
    "Sin título";

  const blocks = await notionGetBlocks(pageId);

  let fullContent = "";
  for (const b of blocks) {
    if (b.type === "table" && b.has_children) {
      const rows = await notionGetBlocks(b.id);
      fullContent += blocksToText(rows);
    } else {
      const richTexts = b[b.type]?.rich_text || [];
      const line = richTexts.map((t) => t.plain_text).join("");
      switch (b.type) {
        case "heading_1": fullContent += `\n# ${line}\n`; break;
        case "heading_2": fullContent += `\n## ${line}\n`; break;
        case "heading_3": fullContent += `\n### ${line}\n`; break;
        case "paragraph": fullContent += `${line}\n`; break;
        case "bulleted_list_item": fullContent += `- ${line}\n`; break;
        case "numbered_list_item": fullContent += `1. ${line}\n`; break;
        case "toggle": fullContent += `▸ ${line}\n`; break;
        case "callout":
          const ct = richTexts.map((t) => t.plain_text).join("");
          fullContent += `> ${ct}\n`; break;
        case "divider": fullContent += `---\n`; break;
        default: if (line) fullContent += `${line}\n`;
      }
      if (b.has_children && !["child_page", "child_database", "table"].includes(b.type)) {
        const children = await notionGetBlocks(b.id);
        fullContent += blocksToText(children, 1);
      }
    }
  }

  return { title, content: fullContent, id: pageId };
}

async function createSubPage(parentId, title, markdownContent) {
  const lines = markdownContent.split("\n");
  const children = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      children.push({
        object: "block", type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] },
      });
    } else if (line.startsWith("## ")) {
      children.push({
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith("# ")) {
      children.push({
        object: "block", type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] },
      });
    } else if (line.startsWith("---")) {
      children.push({ object: "block", type: "divider", divider: {} });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      children.push({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseRichText(line.slice(2)) },
      });
    } else if (/^\d+\.\s/.test(line)) {
      children.push({
        object: "block", type: "numbered_list_item",
        numbered_list_item: { rich_text: parseRichText(line.replace(/^\d+\.\s/, "")) },
      });
    } else if (line.startsWith("> ")) {
      children.push({
        object: "block", type: "callout",
        callout: {
          icon: { type: "emoji", emoji: "📌" },
          rich_text: [{ type: "text", text: { content: line.slice(2) } }],
        },
      });
    } else {
      children.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: parseRichText(line) },
      });
    }
  }

  const batches = [];
  for (let i = 0; i < children.length; i += 100) {
    batches.push(children.slice(i, i + 100));
  }

  const createR = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: parentId },
      icon: { type: "emoji", emoji: "📝" },
      properties: {
        title: { title: [{ text: { content: title } }] },
      },
      children: batches[0] || [],
    }),
  });
  const created = await createR.json();

  if (created.id && batches.length > 1) {
    for (let i = 1; i < batches.length; i++) {
      await fetch(`${NOTION_API}/blocks/${created.id}/children`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ children: batches[i] }),
      });
    }
  }

  return created;
}

function parseRichText(text) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", text: { content: text.slice(lastIndex, match.index) } });
    }
    parts.push({
      type: "text",
      text: { content: match[1] },
      annotations: { bold: true },
    });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", text: { content: text.slice(lastIndex) } });
  }
  return parts.length ? parts : [{ type: "text", text: { content: text } }];
}

// ─── ANTHROPIC HELPER ─────────────────────────────────────────────

async function callClaude(system, userMessage) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos el analizador de entrevistas de Humand. Genera un feedback estructurado y accionable.

## CONTEXTO HUMAND
SaaS B2B de HR. 1.6M usuarios, 1500+ clientes, 50+ paises, 450+ personas.
3 pilares CX: Analisis, Care (relacion), Comercial.
ADN Humander: Smart y Sweet. Startup-ready, hands-on, resiliente, teamplayer, comunicacion directa.

## TECHNICAL FIT:
- Gestion de cartera y ciclo de cliente
- Analisis y orientacion a datos
- Mentalidad consultiva y care
- Orientacion comercial + Pushy
- Tech skills y herramientas

## CULTURAL FIT:
- Comunicacion (claridad, energia, sintesis)
- Resiliencia / Frustracion
- Stakeholder management
- IA y optimizacion
- Feedback (apertura, mirada critica)
- Motivacion (intrinseca vs extrinseca, fit startup)

## FORMATO:

### HR Interview

**Resumen:** Storytelling 4-6 lineas con background, experiencia clave y LinkedIn si esta disponible. Sugerir squad (Early/Late/Enterprise) si hay evidencia.

---

**Fortalezas:**
Numerar las fortalezas principales con evidencia concreta del transcript y/o percepciones del template. Cada fortaleza debe tener un titulo en bold y 2-3 lineas de desarrollo con ejemplo especifico.

---

**Puntos de atencion:**
Numerar gaps, red flags u oportunidades de mejora con evidencia. Ser directo pero constructivo.

---

**Datos de cierre:**
Salario, disponibilidad, ingles, otros procesos. 1-2 lineas.

---

**Recomendacion:** Emoji + recomendacion directa en una linea. Squad sugerido si aplica.
🟩 Strong Yes | 🟢 Yes | 🟡 Maybe | 🔴 No

---

> 📌 Feedback generado con IA a partir del template de entrevista en Notion + transcript. Entrevistador/a: [nombre si se identifica]. Fecha: [fecha de hoy].

## REGLAS
- Evidencia SIEMPRE. Si algo no se evaluo, decilo: "no se evaluo en esta instancia".
- No inventes datos. Se directo y conciso.
- Escribi en espanol rioplatense salvo que se pida en ingles.
- No digas "en el transcript se ve" ni "segun las notas". Integra la evidencia naturalmente.
- Cita ejemplos concretos del candidato (situaciones, metricas, herramientas mencionadas).
- Si hay contradiccion entre percepciones del recruiter y transcript, mencionalo.`;

// ─── MAIN HANDLER ─────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { candidato, rol, area, transcript, lang } = req.body;
    if (!candidato || !rol) {
      return res.status(400).json({ error: "Faltan candidato y/o rol" });
    }

    const steps = [];

    // ── Step 1: Search kickoff/JD in Notion ──
    steps.push({ step: "kickoff", status: "searching" });
    let kickoffText = "No encontrado.";
    try {
      const queries = [
        `kick off ${rol}`,
        `kickoff ${rol} ${area || "CX"}`,
        `job description ${rol}`,
      ];
      let kickoffPage = null;
      for (const q of queries) {
        if (kickoffPage) break;
        const kickoffSearch = await notionSearch(q);
        const kickoffPages = (kickoffSearch.results || []).filter(
          (r) => r.object === "page"
        );
        kickoffPage = kickoffPages.find((p) => {
          const title = (
            p.properties?.title?.title?.[0]?.plain_text || ""
          ).toLowerCase();
          return (
            (title.includes("kick off") || title.includes("kickoff")) &&
            title.includes(rol.toLowerCase().split(" ")[0])
          );
        }) || (kickoffPages.length > 0 ? kickoffPages[0] : null);
      }
      if (kickoffPage) {
        const kp = await getPageContent(kickoffPage.id);
        kickoffText = `# ${kp.title}\n${kp.content}`;
      }
    } catch (e) {
      kickoffText = `Error buscando kickoff: ${e.message}`;
    }

    // ── Step 2: Search candidate template in Notion ──
    steps.push({ step: "template", status: "searching" });
    let templateText = "No encontrado.";
    let candidatePageId = null;
    try {
      const firstName = candidato.split(" ")[0].toLowerCase();
      const lastName = candidato.split(" ").slice(1).join(" ").toLowerCase();
      const tmplSearch = await notionSearch(`${candidato}`);
      const tmplPages = (tmplSearch.results || []).filter(
        (r) => r.object === "page"
      );
      if (tmplPages.length > 0) {
        const best =
          tmplPages.find((p) => {
            const t = (p.properties?.title?.title?.[0]?.plain_text || "").toLowerCase();
            return (
              !t.includes("feedback ia") &&
              (t.includes("entrevista") || t.includes("interview")) &&
              t.includes(firstName)
            );
          }) ||
          tmplPages.find((p) => {
            const t = (p.properties?.title?.title?.[0]?.plain_text || "").toLowerCase();
            return !t.includes("feedback ia") && t.includes(firstName);
          }) ||
          tmplPages[0];
        const tp = await getPageContent(best.id);
        templateText = `# ${tp.title}\n${tp.content}`;
        candidatePageId = best.id;
      }
    } catch (e) {
      templateText = `Error buscando template: ${e.message}`;
    }

    // ── Step 3: Generate feedback with Claude ──
    steps.push({ step: "feedback", status: "generating" });
    const langNote = lang === "en"
      ? "\n\nIMPORTANT: Write the entire feedback in English."
      : "";
    const today = new Date().toLocaleDateString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });

    const userMsg = `## KICKOFF / JOB DESCRIPTION
${kickoffText}

## TEMPLATE ENTREVISTA (percepciones del recruiter)
${templateText}

## TRANSCRIPT
${transcript || "No disponible — genera el feedback solo con lo que haya en el template."}

Genera el feedback para ${candidato} para el rol de ${rol} (${area || "CX"}). Fecha: ${today}.${langNote}`;

    const feedback = await callClaude(SYSTEM_PROMPT, userMsg);

    // ── Step 4: Save feedback as sub-page in Notion ──
    let notionUrl = null;
    if (candidatePageId) {
      try {
        steps.push({ step: "notion", status: "saving" });
        const title = `Feedback IA - ${candidato} (${rol})`;
        const created = await createSubPage(candidatePageId, title, feedback);
        if (created.id) {
          notionUrl = `https://www.notion.so/${created.id.replace(/-/g, "")}`;
        }
      } catch (e) {
        console.error("Error saving to Notion:", e.message);
      }
    }

    return res.status(200).json({
      feedback,
      notionUrl,
      candidatePageId,
      steps,
    });
  } catch (e) {
    console.error("Handler error:", e);
    return res.status(500).json({ error: e.message });
  }
}
