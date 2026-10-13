// One deep color per person: their circle, name tag and chat name match. Picked from the name, the next free one if taken, kept for the page's life.
// ponytail: a 5th name (a rename, someone who left) can share a color
const PERSON_COLORS = ["#0b6b80", "#12704f", "#7a2e5c", "#a8530f"]; // teal, green, plum, rust: readable as text on white and under white initials, none the "on" blue
const personColors = new Map();
function personColor(name) {
  if (!personColors.has(name)) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
    const taken = [...personColors.values()], free = PERSON_COLORS.map((_, i) => PERSON_COLORS[(h + i) % PERSON_COLORS.length]).find(c => !taken.includes(c));
    personColors.set(name, free || PERSON_COLORS[h % PERSON_COLORS.length]);
  }
  return personColors.get(name);
}

// One chat line, on the call page and the end page. Name and message come from peers: text only, http(s) links clickable.
function chatLine(name, msg) {
  const line = document.createElement("div");
  if (name) {
    const b = document.createElement("b");
    b.className = "chatName";
    b.textContent = name;
    b.style.color = personColor(name);
    line.append(b, ": ");
  }
  msg.split(/(https?:\/\/\S+)/).forEach((part, i) => { // odd parts are links
    if (i % 2) {
      const a = document.createElement("a");
      a.href = a.textContent = part;
      a.target = "_blank";
      a.rel = "noopener";
      line.append(a);
    } else {
      line.append(part);
    }
  });
  return line;
}
