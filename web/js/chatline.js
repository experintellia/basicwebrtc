// One chat line, on the call page and the end page. Name and message come from peers: text only, http(s) links clickable.
function chatLine(name, msg) {
  const line = document.createElement("div");
  if (name) {
    const b = document.createElement("b");
    b.className = "chatName";
    b.textContent = name;
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
