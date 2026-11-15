// A small, safe Markdown renderer for Claude's replies. It builds DOM nodes with textContent, never innerHTML,
// so nothing in a reply can inject markup. Covers what Claude writes: paragraphs, headings, lists, quotes, code
// fences (with a copy button), inline code, bold, italic and links.
'use strict';
window.renderMarkdown = function (text, into) {
  into.replaceChildren();
  var lines = String(text).replace(/\r\n/g, '\n').split('\n'), i = 0;
  function inline(parent, s) {
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<)]+)/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parent.append(s.slice(last, m.index));
      var t = m[0], n;
      if (m[1]) { n = document.createElement('code'); n.textContent = t.slice(1, -1); }
      else if (m[2]) { n = document.createElement('strong'); n.textContent = t.slice(2, -2); }
      else if (m[3]) { n = document.createElement('em'); n.textContent = t.slice(1, -1); }
      else if (m[4]) { var p = /\[([^\]]+)\]\((.+)\)/.exec(t); n = document.createElement('a'); n.textContent = p[1]; n.href = p[2]; n.target = '_blank'; n.rel = 'noreferrer'; }
      else { n = document.createElement('a'); n.textContent = t; n.href = t; n.target = '_blank'; n.rel = 'noreferrer'; }
      parent.append(n); last = m.index + t.length;
    }
    if (last < s.length) parent.append(s.slice(last));
  }
  function el(tag, parent) { var n = document.createElement(tag); parent.append(n); return n; }
  while (i < lines.length) {
    var ln = lines[i], m;
    if ((m = /^```(\S*)/.exec(ln))) {
      var buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      var box = el('div', into); box.className = 'code';
      var head = el('div', box); head.className = 'lang';
      var lang = el('span', head); lang.textContent = m[1] || 'text';
      var btn = el('button', head); btn.type = 'button'; btn.textContent = 'Copy';
      var code = buf.join('\n');
      btn.onclick = function () { navigator.clipboard.writeText(code).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); }); };
      var pre = el('pre', box); pre.textContent = code;
    } else if ((m = /^(#{1,4})\s+(.*)/.exec(ln))) { inline(el('h' + m[1].length, into), m[2]); i++; }
    else if (/^\s*[-*]\s+/.test(ln) || /^\s*\d+[.)]\s+/.test(ln)) {
      var ordered = /^\s*\d+[.)]/.test(ln), list = el(ordered ? 'ol' : 'ul', into);
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) { inline(el('li', list), lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, '')); i++; }
    } else if (/^>\s?/.test(ln)) {
      var q = el('blockquote', into), qb = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) qb.push(lines[i++].replace(/^>\s?/, ''));
      inline(q, qb.join(' '));
    } else if (!ln.trim()) { i++; }
    else {
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i])) para.push(lines[i++]);
      inline(el('p', into), para.join(' '));
    }
  }
};
