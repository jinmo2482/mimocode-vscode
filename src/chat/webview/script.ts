export function getScript(): string {
    return String.raw`
var vscode = acquireVsCodeApi();
var state = { sessions: [], currentSessionId: null, busy: false, sseState: 'disconnected', model: undefined, agentMode: 'build' };
var timeline = { messages: [], diffs: [], errors: [] };

var els = {
  statusDot: document.getElementById('status-dot'),
  sessionSelect: document.getElementById('session-select'),
  newSession: document.getElementById('new-session'),
  refresh: document.getElementById('refresh'),
  meta: document.getElementById('meta'),
  timeline: document.getElementById('timeline'),
  mentions: document.getElementById('mentions'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  abort: document.getElementById('abort'),
  loginScreen: document.getElementById('login-screen'),
  signInBtn: document.getElementById('sign-in-btn'),
  agentBar: document.getElementById('agent-bar')
};

/* ── Auto-grow textarea ── */
function autoGrow() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = Math.min(els.prompt.scrollHeight, 200) + 'px';
}
els.prompt.addEventListener('input', autoGrow);

/* ── Agent mode selector ── */
els.agentBar.addEventListener('click', function(e) {
  var pill = e.target.closest('.agent-pill');
  if (!pill) return;
  var mode = pill.getAttribute('data-agent');
  if (!mode || mode === state.agentMode) return;
  state.agentMode = mode;
  var pills = els.agentBar.querySelectorAll('.agent-pill');
  for (var i = 0; i < pills.length; i++) {
    pills[i].classList.toggle('active', pills[i].getAttribute('data-agent') === mode);
  }
});

/* ── Message handling ── */
window.addEventListener('message', function(event) {
  var msg = event.data;
  switch (msg.type) {
    case 'shellState':
      state = Object.assign({}, state, msg);
      renderShell();
      break;
    case 'timelineSnapshot':
      timeline = msg.snapshot || { messages: [], diffs: [], errors: [] };
      renderTimeline();
      break;
    case 'pendingDiffs':
      state.pendingDiffs = msg.diffs || [];
      renderTimeline();
      break;
    case 'mentionResults':
      renderMentions(msg.items || []);
      break;
    case 'mentionContent':
      break;
    case 'timelinePatch':
      // No-op: the webview currently relies on timelineSnapshot (full re-render)
      // for all timeline updates. Patch-based incremental DOM updates are not yet
      // implemented. This case exists so the message is explicitly handled rather
      // than silently falling through to the default branch.
      break;
    case 'error':
      console.error(msg.message);
      break;
  }
});

/* ── Event bindings ── */
els.newSession.addEventListener('click', function() { vscode.postMessage({ type: 'newSession' }); });
els.refresh.addEventListener('click', function() { vscode.postMessage({ type: 'refresh' }); });
els.abort.addEventListener('click', function() { vscode.postMessage({ type: 'abort' }); });
els.send.addEventListener('click', sendPrompt);
els.signInBtn.addEventListener('click', function() { vscode.postMessage({ type: 'signIn' }); });
els.sessionSelect.addEventListener('change', function() {
  var sessionId = els.sessionSelect.value;
  if (sessionId) vscode.postMessage({ type: 'switchSession', sessionId: sessionId });
});
els.prompt.addEventListener('keydown', function(event) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendPrompt();
  }
});
els.prompt.addEventListener('input', function() {
  var query = currentMentionQuery();
  if (query === null) {
    els.mentions.classList.add('hidden');
  } else {
    vscode.postMessage({ type: 'searchMention', query: query });
  }
});
els.timeline.addEventListener('click', function(event) {
  var button = event.target.closest('[data-action]');
  if (!button) return;
  var action = button.getAttribute('data-action');
  if (!action) return;
  var msg = { type: action };
  var diffId = button.getAttribute('data-diff-id');
  if (diffId) msg.diffId = diffId;
  var messageId = button.getAttribute('data-message-id');
  if (messageId) msg.messageId = messageId;
  var sessionId = button.getAttribute('data-session-id');
  if (sessionId) msg.sessionId = sessionId;
  vscode.postMessage(msg);
});

function sendPrompt() {
  var text = els.prompt.value.trim();
  if (!text || state.busy) return;
  var msg = { type: 'sendPrompt', text: text, sessionId: state.currentSessionId };
  if (state.agentMode) msg.agent = state.agentMode;
  vscode.postMessage(msg);
  els.prompt.value = '';
  autoGrow();
}

/* ── Shell / header render ── */
function renderShell() {
  var status = state.sseState || 'disconnected';
  els.statusDot.className = 'status-dot ' + status;

  var providers = state.providers;
  var connected = providers && providers.connected && providers.connected.length > 0;
  if (!connected) {
    els.loginScreen.classList.remove('hidden');
    els.timeline.style.display = 'none';
    els.mentions.style.display = 'none';
    document.querySelector('.composer').style.display = 'none';
    document.querySelector('.header').style.display = 'none';
  } else {
    els.loginScreen.classList.add('hidden');
    els.timeline.style.display = '';
    els.mentions.style.display = '';
    document.querySelector('.composer').style.display = '';
    document.querySelector('.header').style.display = '';
  }

  els.sessionSelect.innerHTML = '';
  if (!state.sessions || state.sessions.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No session';
    els.sessionSelect.appendChild(opt);
  } else {
    for (var i = 0; i < state.sessions.length; i++) {
      var session = state.sessions[i];
      var opt = document.createElement('option');
      opt.value = session.id;
      opt.textContent = session.title || session.id.slice(0, 8);
      opt.selected = session.id === state.currentSessionId;
      els.sessionSelect.appendChild(opt);
    }
  }

  els.send.disabled = !!state.busy;
  if (state.busy) {
    els.abort.classList.remove('hidden');
  } else {
    els.abort.classList.add('hidden');
  }

  var statusLabel = timeline.status && (timeline.status.message || timeline.status.type) || (state.busy ? 'running' : 'idle');
  els.meta.innerHTML = chip(statusLabel) + chip(state.model || 'default');
}

/* ── Timeline render ── */
function renderTimeline() {
  renderShell();
  var chunks = [];
  if ((!timeline.messages || timeline.messages.length === 0) && (!timeline.errors || timeline.errors.length === 0)) {
    chunks.push('<div class="empty"><div class="empty-icon">&#x1F4AC;</div><div class="empty-text">Start a conversation with MiMoCode.</div></div>');
  }
  for (var i = 0; i < (timeline.messages || []).length; i++) {
    chunks.push(renderMessage(timeline.messages[i]));
  }
  for (var i = 0; i < (timeline.diffs || []).length; i++) {
    chunks.push(renderSessionDiff(timeline.diffs[i]));
  }
  for (var i = 0; i < (timeline.errors || []).length; i++) {
    chunks.push(renderErrorCard(timeline.errors[i].message));
  }
  for (var i = 0; i < (state.pendingDiffs || []).length; i++) {
    chunks.push(renderPendingDiff(state.pendingDiffs[i]));
  }
  els.timeline.innerHTML = chunks.join('');
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

/* ── Message (transcript) ── */
function renderMessage(message) {
  var info = message.info || {};
  var parts = message.parts || [];
  var role = info.role || 'assistant';
  var when = info.time && info.time.created ? new Date(info.time.created).toLocaleTimeString() : '';
  var label = role === 'user' ? 'You' : 'MiMo';
  var meta = metaForMessage(info, when);
  var agentBadge = info.agent ? '<span class="msg-agent">' + escapeHtml(info.agent) + '</span>' : '';
  return '<article class="message ' + escapeAttr(role) + '">' +
    '<div class="msg-role">' + escapeHtml(label) + agentBadge +
      (meta ? '<span class="msg-time">' + escapeHtml(meta) + '</span>' : '') +
    '</div>' +
    '<div class="msg-body">' + mapRender(parts, renderPart).join('') + renderMessageError(info) + '</div>' +
  '</article>';
}

function metaForMessage(info, when) {
  var bits = [];
  if (info.providerID && info.modelID) bits.push(info.providerID + '/' + info.modelID);
  if (when) bits.push(when);
  return bits.join(' · ');
}

function renderMessageError(info) {
  if (!info.error) return '';
  return renderErrorCard(errorText(info.error));
}

/* ── Part routing ── */
function renderPart(part) {
  if (!part) return '';
  switch (part.type) {
    case 'text':
      return '<div class="part text">' + renderMarkdown(part.text || '') + '</div>';
    case 'reasoning':
      return renderCollapsible('Reasoning', part.text || '', 'part');
    case 'tool':
      return renderTool(part);
    case 'step-start':
      return renderStepStart(part);
    case 'step-finish':
      return renderStepFinish(part);
    case 'retry':
      return renderRetry(part);
    case 'patch':
      return renderPatch(part);
    case 'file':
      return renderFile(part);
    case 'agent':
      return renderAgentCard(part);
    case 'subtask':
      return renderSubtask(part);
    case 'checkpoint':
      return renderCheckpoint(part);
    case 'compaction':
      return renderCompaction(part);
    case 'snapshot':
      return renderSnapshot(part);
    default:
      return renderCollapsible(part.type || 'part', JSON.stringify(part, null, 2), 'part');
  }
}

/* ── Tool card ── */
function renderTool(part) {
  var s = part.state || {};
  var title = s.title || part.tool || 'tool';
  var status = s.status || 'pending';
  var badgeClass = status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'pending';
  var icon = status === 'running' ? '&#x23F3;' : status === 'completed' ? '&#x2713;' : status === 'error' ? '&#x2717;' : '&#x25CB;';
  var body = s.output || s.error || s.raw || '';
  var inputSummary = s.input ? truncate(JSON.stringify(s.input), 80) : '';
  var summary = inputSummary || (body ? truncate(body, 60) : '');
  var openAttr = status === 'running' ? ' open' : '';
  var summaryLine = summary ? '<div class="card-summary">' + escapeHtml(summary) + '</div>' : '';
  return '<details class="card"' + openAttr + '>' +
    '<summary class="card-row">' +
      '<span class="card-icon">' + icon + '</span>' +
      '<span class="card-title">' + escapeHtml(title) + '</span>' +
      '<span class="card-badge ' + badgeClass + '">' + escapeHtml(status) + '</span>' +
    '</summary>' +
    summaryLine +
    (body ? '<div class="card-detail"><pre>' + escapeHtml(body) + '</pre></div>' : '') +
  '</details>';
}

/* ── Step start ── */
function renderStepStart(part) {
  var snapshot = part.snapshot ? ': ' + truncate(part.snapshot, 40) : '';
  return '<div class="step-line"><span class="step-icon">&#x25B6;</span><span class="step-text">Step started' + escapeHtml(snapshot) + '</span></div>';
}

/* ── Step finish ── */
function renderStepFinish(part) {
  var bits = [];
  if (typeof part.cost === 'number') bits.push('$' + part.cost.toFixed(4));
  if (part.tokens && part.tokens.total) bits.push(part.tokens.total + ' tok');
  var reason = part.reason || 'done';
  var meta = bits.length ? '<span class="step-meta">' + escapeHtml(bits.join(' · ')) + '</span>' : '';
  return '<div class="step-line"><span class="step-icon">&#x25B6;</span><span class="step-text">Step: ' + escapeHtml(reason) + '</span>' + meta + '</div>';
}

/* ── Retry ── */
function renderRetry(part) {
  var errMsg = part.error ? (part.error.message || part.error.name || JSON.stringify(part.error)) : 'unknown error';
  return renderCollapsible('Retry #' + (part.attempt || '?') + ' — ' + truncate(errMsg, 60), errMsg, 'part');
}

/* ── Patch ── */
function renderPatch(part) {
  var files = part.files || [];
  var summary = files.length + ' file' + (files.length !== 1 ? 's' : '');
  return '<div class="card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F4C4;</span>' +
      '<span class="card-title">Patch</span>' +
      '<span class="card-badge">' + escapeHtml(summary) + '</span>' +
    '</div>' +
    (files.length ? '<div class="card-summary">' + escapeHtml(truncate(files.join(', '), 80)) + '</div>' : '') +
  '</div>';
}

/* ── File ── */
function renderFile(part) {
  var name = part.filename || part.url || 'attachment';
  return '<div class="card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F4C1;</span>' +
      '<span class="card-title">' + escapeHtml(name) + '</span>' +
    '</div>' +
  '</div>';
}

/* ── Agent card ── */
function renderAgentCard(part) {
  var name = part.name || 'agent';
  return '<div class="card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F916;</span>' +
      '<span class="card-title">Agent: ' + escapeHtml(name) + '</span>' +
    '</div>' +
  '</div>';
}

/* ── Subtask ── */
function renderSubtask(part) {
  var desc = part.description || part.agent || 'subtask';
  var detail = part.prompt || '';
  return renderCollapsible('Subtask: ' + desc, detail, 'part');
}

/* ── Checkpoint ── */
function renderCheckpoint(part) {
  var num = part.checkpointNumber || '?';
  var mid = part.messageID || '';
  var sid = part.sessionID || '';
  return '<div class="card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F6D1;</span>' +
      '<span class="card-title">Checkpoint #' + escapeHtml(String(num)) + '</span>' +
    '</div>' +
    '<div class="card-actions">' +
      '<button class="card-btn" data-action="forkSession" data-message-id="' + escapeAttr(mid) + '" data-session-id="' + escapeAttr(sid) + '" title="Fork from here">Fork</button>' +
      '<button class="card-btn" data-action="revertSession" data-message-id="' + escapeAttr(mid) + '" data-session-id="' + escapeAttr(sid) + '" title="Revert to here">Revert</button>' +
    '</div>' +
  '</div>';
}

/* ── Compaction ── */
function renderCompaction(part) {
  var label = part.auto ? 'Context auto-compacted' : 'Context compacted';
  var overflow = part.overflow ? ' (overflow)' : '';
  return '<div class="step-line"><span class="step-icon">&#x1F4C9;</span><span class="step-text">' + escapeHtml(label + overflow) + '</span></div>';
}

/* ── Snapshot ── */
function renderSnapshot(part) {
  var label = part.snapshot || '';
  return '<div class="step-line"><span class="step-icon">&#x1F4F8;</span><span class="step-text">Snapshot' + (label ? ': ' + escapeHtml(truncate(label, 50)) : '') + '</span></div>';
}

/* ── Session diff ── */
function renderSessionDiff(diff) {
  var files = diff.files || [];
  var summary = files.length + ' file' + (files.length !== 1 ? 's' : '') + ' changed';
  return '<div class="diff-card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F4DD;</span>' +
      '<span class="card-title">Session diff</span>' +
      '<span class="card-badge">' + escapeHtml(summary) + '</span>' +
    '</div>' +
    '<div class="diff-files">' + escapeHtml(mapFiles(files).join(', ')) + '</div>' +
  '</div>';
}

/* ── Pending diff ── */
function renderPendingDiff(diff) {
  var name = diff.filePath ? diff.filePath.split(/[\\/]/).pop() : 'unknown';
  var reason = diff.conflictReason ? renderErrorCard(diff.conflictReason) : '';
  return '<div class="diff-card">' +
    '<div class="card-row">' +
      '<span class="card-icon">&#x1F4DD;</span>' +
      '<span class="card-title">' + escapeHtml(name) + '</span>' +
      '<span class="card-badge">' + escapeHtml(diff.status || 'pending') + '</span>' +
    '</div>' +
    reason +
    '<div class="diff-actions">' +
      '<button data-action="viewDiff" data-diff-id="' + escapeAttr(diff.id) + '">View</button>' +
      '<button data-action="acceptDiff" data-diff-id="' + escapeAttr(diff.id) + '">Accept</button>' +
      '<button data-action="rejectDiff" data-diff-id="' + escapeAttr(diff.id) + '">Reject</button>' +
    '</div>' +
  '</div>';
}

/* ── Error card ── */
function renderErrorCard(message) {
  return '<div class="error-card">' + escapeHtml(message) + '</div>';
}

/* ── Collapsible helper ── */
function renderCollapsible(title, body, cls) {
  return '<details class="' + (cls || '') + ' collapsible">' +
    '<summary>' + escapeHtml(title) + '</summary>' +
    '<pre>' + escapeHtml(body) + '</pre>' +
  '</details>';
}

/* ── Mentions ── */
function renderMentions(items) {
  if (!items.length) {
    els.mentions.classList.add('hidden');
    return;
  }
  els.mentions.innerHTML = items.map(function(item, index) {
    return '<div class="mention-item" data-index="' + index + '">' +
      '<div>' + escapeHtml(item.label) + '</div>' +
      '<div class="mention-path">' + escapeHtml(item.description || item.path || '') + '</div>' +
    '</div>';
  }).join('');
  els.mentions.classList.remove('hidden');
  var nodes = els.mentions.querySelectorAll('.mention-item');
  for (var i = 0; i < nodes.length; i++) {
    (function(node) {
      node.addEventListener('click', function() {
        var item = items[Number(node.dataset.index)];
        insertMention(item);
        els.mentions.classList.add('hidden');
      });
    })(nodes[i]);
  }
}

function insertMention(item) {
  var value = '@' + (item.description || item.path || item.label);
  var query = currentMentionQuery();
  var pos = els.prompt.selectionStart;
  var start = query === null ? pos : pos - query.length - 1;
  els.prompt.value = els.prompt.value.slice(0, start) + value + ' ' + els.prompt.value.slice(pos);
  els.prompt.focus();
}

function currentMentionQuery() {
  var pos = els.prompt.selectionStart;
  var before = els.prompt.value.slice(0, pos);
  var match = before.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

/* ── Helpers ── */
function chip(text) { return '<span class="chip">' + escapeHtml(text) + '</span>'; }
function errorText(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.data && error.data.message || error.message || error.name || JSON.stringify(error);
}
function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}
function mapRender(arr, fn) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(fn(arr[i]));
  return out;
}
function mapFiles(files) {
  var out = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    out.push(f.path || f.filePath || f.newPath || f.oldPath || 'unknown');
  }
  return out;
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, function(ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]; });
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
function renderMarkdown(text) {
  // Extract fenced code blocks and inline code BEFORE HTML escaping,
  // so their content is preserved and not broken by \n→<br>.
  // The webview currently relies on timelineSnapshot full re-render;
  // patch-based DOM is not implemented.
  var codeBlocks = [];
  var inlineCodes = [];
  var tick = String.fromCharCode(96);

  // Fenced code blocks: escape content, store for later restoration
  var html = text.replace(new RegExp(tick + tick + tick + '([a-zA-Z]*)\\n([\\s\\S]*?)' + tick + tick + tick, 'g'), function(_, lang, code) {
    var cls = lang ? ' class="language-' + lang + '"' : '';
    codeBlocks.push('<pre><code' + cls + '>' + escapeHtml(code) + '</code></pre>');
    return '%%CODEBLOCK_' + (codeBlocks.length - 1) + '%%';
  });

  // Inline code
  html = html.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), function(_, code) {
    inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
    return '%%INLINECODE_' + (inlineCodes.length - 1) + '%%';
  });

  // HTML-escape the rest
  html = escapeHtml(html);

  // Inline formatting (asterisks are not HTML-escaped, match them directly)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');

  // Restore code blocks and inline code (already HTML-escaped, not re-escaped)
  html = html.replace(/%%CODEBLOCK_(\d+)%%/g, function(_, i) { return codeBlocks[parseInt(i)]; });
  html = html.replace(/%%INLINECODE_(\d+)%%/g, function(_, i) { return inlineCodes[parseInt(i)]; });

  return html;
}

vscode.postMessage({ type: 'ready' });`;
}
