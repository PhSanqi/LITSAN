function materializeCurrentState(sessions, asOf) {
  const active = new Map();
  for (const session of [...sessions].sort((a, b) => Number(a.session_id) - Number(b.session_id))) {
    if (!session.operation || (asOf && session.date > asOf)) continue;
    const details = session.operation_details ?? {};
    const type = session.session_type ?? "memory";
    const item = canonicalItem(details.item) || contentAnchor(details.content_data);
    const oldItem = canonicalItem(details.old_item);
    const key = stateKey(type, details, item);
    const oldKey = oldItem ? stateKey(type, details, oldItem) : "";

    if (session.operation === "update") {
      if (oldKey && oldKey !== key) active.delete(oldKey);
      if (key) active.delete(key);
    }
    if (session.operation === "delete") {
      if (key) active.delete(key);
      if (oldKey) active.delete(oldKey);
    }
    if (details.moved_to_completed === true && !hasContent(details.content_data)) {
      if (key) active.delete(key);
      continue;
    }

    const hasResidualState = session.operation !== "delete" || hasContent(details.content_data);
    if (!key || !hasResidualState) continue;
    active.set(key, {
      key,
      sessionId: Number(session.session_id),
      item,
      eventDate: calendarDate(details.item),
      date: session.date,
      demandKind: stateDemandKind(session, details, item),
      text: stateText(session, details, item)
    });
  }
  return [...active.values()];
}

function stateKey(type, details, item) {
  if (!item) return "";
  return [type, details.category ?? "", details.subcategory ?? "", normalize(item)].join(":");
}

function conditionalStateCandidates(state, query, asOf) {
  if (asOf && /upcoming|future/i.test(query)) state = state.filter(entry => !entry.eventDate || entry.eventDate > asOf);
  const demand = queryDemandKind(query);
  if (!demand) return state;
  const matched = state.filter((entry) => entry.demandKind === demand);
  return matched.length ? matched : state;
}

function queryDemandKind(query) {
  const text = String(query ?? "").toLowerCase();
  if (/meeting notes?/.test(text)) return "meeting_notes";
  if (/project proposal/.test(text)) return "project_proposal";
  if (/\bemail\b/.test(text)) return "email";
  if (/todo|tasks? remain/.test(text)) return "todo";
  if (/calendar|upcoming events?/.test(text)) return "calendar";
  if (/expense|spent|spend/.test(text)) return "expense";
  if (/\bsteps?\b/.test(text)) return "steps";
  if (/\bgoals?\b/.test(text)) return "goal";
  if (/recommend|suggest|\b(?:what|where|which)\b[^?]*\bshould i\b|\bi(?:'m| am) looking for\b/.test(text)) return "preference";
  return null;
}

function stateDemandKind(session, details, item) {
  const normalizedItem = normalize(item);
  if (normalizedItem.includes("meeting notes") || details.content_data?.meeting_title) return "meeting_notes";
  if (normalizedItem.includes("project proposal") || details.content_data?.project_title) return "project_proposal";
  if (normalizedItem.includes("email") || details.content_data?.email_purpose || details.content_data?.email_subject) return "email";
  if (details.category === "todo_list") return "todo";
  if (details.category === "calendar_event") return "calendar";
  if (details.category === "food_expenses") return "expense";
  if (details.category === "step_tracker") return "steps";
  if (session.session_type === "preference") return "preference";
  if (session.session_type === "goal") return "goal";
  return "other";
}

function stateText(session, details, item) {
  const pieces = [
    `type: ${session.session_type ?? "memory"}`,
    details.category ? `category: ${details.category}` : "",
    details.subcategory ? `subcategory: ${details.subcategory}` : "",
    item ? `item: ${item}` : "",
    details.preference ? `preference: ${details.preference}` : "",
    hasContent(details.content_data) ? `content: ${flatten(details.content_data)}` : "",
    `operation: ${session.operation}`
  ].filter(Boolean);
  return pieces.join("\n");
}

function canonicalItem(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["event_name", "description", "title", "name", "task", "goal", "event"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return flatten(value);
}

function contentAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of ["meeting_title", "project_title", "title", "email_subject", "email_purpose", "event_title", "name"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function flatten(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("; ");
  if (typeof value === "object") return Object.entries(value).map(([key, child]) => `${key}: ${flatten(child)}`).join("; ");
  return "";
}

function hasContent(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}


function calendarDate(item) {
  if (!item || typeof item !== "object" || typeof item.date !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return item.date;
  const relative = /^([+-]?\d+) days?$/.exec(item.date);
  const anchor = item.created_at;
  if (!relative || typeof anchor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return undefined;
  const date = new Date(anchor + "T00:00:00Z");
  if (!Number.isFinite(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + Number(relative[1]));
  return date.toISOString().slice(0, 10);
}
export {materializeCurrentState, conditionalStateCandidates};
