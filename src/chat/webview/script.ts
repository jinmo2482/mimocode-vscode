export function getScript(): string {
    return String.raw`
var vscode = acquireVsCodeApi();
var state = { sessions: [], currentSessionId: null, busy: false, sseState: 'disconnected', model: undefined, agentMode: 'build', models: [], variant: undefined, variantOptions: [] };
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
  agentBar: document.getElementById('agent-bar'),
  modelSelect: document.getElementById('model-select'),
  variantSelect: document.getElementById('variant-select')
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

/* ── Model / variant selectors ── */
els.modelSelect.addEventListener('change', function() {
  var val = els.modelSelect.value;
  if (val) vscode.postMessage({ type: 'setModel', model: val });
});
els.variantSelect.addEventListener('change', function() {
  var val = els.variantSelect.value;
  vscode.postMessage({ type: 'setVariant', variant: val });
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

  // Handle question tool option clicks
  if (action === 'answerQuestion') {
    var qAnswer = button.getAttribute('data-answer') || '';
    var qToolCallId = button.getAttribute('data-tool-call-id') || '';
    var qMessageId = button.getAttribute('data-message-id') || '';
    var qSessionId = button.getAttribute('data-session-id') || '';
    var qRequestId = button.getAttribute('data-request-id') || '';
    console.log('[MiMoCode Webview] answerQuestion clicked', {
      answer: qAnswer,
      toolCallId: qToolCallId,
      messageId: qMessageId,
      sessionId: qSessionId,
      requestID: qRequestId
    });
    // Disable all option buttons in this card and show sent state
    var qCard = button.closest('.question-card');
    if (qCard) {
      var allBtns = qCard.querySelectorAll('.question-opt-btn');
      for (var bi = 0; bi < allBtns.length; bi++) {
        allBtns[bi].disabled = true;
        allBtns[bi].classList.add('question-opt-disabled');
      }
      button.classList.add('question-opt-selected');
      button.textContent = button.textContent + ' ✓';
    }
    vscode.postMessage({
      type: 'answerQuestion',
      answer: qAnswer,
      toolCallId: qToolCallId,
      messageId: qMessageId,
      sessionId: qSessionId,
      requestID: qRequestId
    });
    return;
  }
  // Handle question tool text input submit
  if (action === 'answerQuestionInput') {
    var qCard2 = button.closest('.question-card');
    var inputEl = qCard2 ? qCard2.querySelector('.question-input') : null;
    var textAnswer = inputEl ? inputEl.value.trim() : '';
    if (!textAnswer) return;
    var qToolCallId2 = button.getAttribute('data-tool-call-id') || '';
    var qMessageId2 = button.getAttribute('data-message-id') || '';
    var qSessionId2 = button.getAttribute('data-session-id') || '';
    var qRequestId2 = button.getAttribute('data-request-id') || '';
    console.log('[MiMoCode Webview] answerQuestionInput submitted', {
      answer: textAnswer,
      toolCallId: qToolCallId2,
      requestID: qRequestId2
    });
    // Disable input and button
    if (inputEl) inputEl.disabled = true;
    button.disabled = true;
    button.textContent = 'Sent ✓';
    vscode.postMessage({
      type: 'answerQuestion',
      answer: textAnswer,
      toolCallId: qToolCallId2,
      messageId: qMessageId2,
      sessionId: qSessionId2,
      requestID: qRequestId2
    });
    return;
  }

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

  renderControls();
}

/* ── Model / variant select render ── */
function renderControls() {
  // Model select
  var models = state.models || [];
  var currentModel = state.model || '';
  els.modelSelect.innerHTML = '';
  if (models.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = currentModel || 'No model';
    opt.disabled = true;
    els.modelSelect.appendChild(opt);
    els.modelSelect.disabled = true;
  } else {
    // Ensure current model is in the list
    var found = false;
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var o = document.createElement('option');
      o.value = m.label;
      o.textContent = m.label;
      o.title = m.description || m.label;
      if (m.label === currentModel) { o.selected = true; found = true; }
      els.modelSelect.appendChild(o);
    }
    if (!found && currentModel) {
      var o2 = document.createElement('option');
      o2.value = currentModel;
      o2.textContent = currentModel;
      o2.title = 'Current configured model';
      o2.selected = true;
      els.modelSelect.insertBefore(o2, els.modelSelect.firstChild);
    }
    els.modelSelect.disabled = !!state.busy;
  }

  // Variant select
  var variants = state.variantOptions || [];
  var currentVariant = state.variant || '';
  els.variantSelect.innerHTML = '';
  if (variants.length === 0) {
    // No variants available — show informative disabled state
    var noVarOpt = document.createElement('option');
    noVarOpt.value = '';
    noVarOpt.textContent = 'default (no variants)';
    noVarOpt.title = 'Current model does not expose reasoning effort variants';
    els.variantSelect.appendChild(noVarOpt);
    els.variantSelect.disabled = true;
    els.variantSelect.title = 'Current model does not expose reasoning effort variants';
  } else {
    // Default option
    var defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'default';
    els.variantSelect.appendChild(defOpt);
    for (var j = 0; j < variants.length; j++) {
      var vo = document.createElement('option');
      vo.value = variants[j];
      vo.textContent = variants[j];
      if (variants[j] === currentVariant) vo.selected = true;
      els.variantSelect.appendChild(vo);
    }
    els.variantSelect.disabled = !!state.busy;
    els.variantSelect.title = '';
  }
}

/* ── Timeline render ── */
function renderTimeline() {
  renderShell();
  var chunks = [];
  var messages = timeline.messages || [];
  var errors = timeline.errors || [];
  var diffs = timeline.diffs || [];
  if (messages.length === 0 && errors.length === 0) {
    chunks.push('<div class="empty"><div class="empty-icon">&#x1F4AC;</div><div class="empty-text">Start a conversation with MiMoCode.</div></div>');
  }
  // Build a map of messageID -> errors for message-level errors
  var msgErrors = {};
  var sessionErrors = [];
  for (var ei = 0; ei < errors.length; ei++) {
    var err = errors[ei];
    if (err.messageID) {
      if (!msgErrors[err.messageID]) msgErrors[err.messageID] = [];
      msgErrors[err.messageID].push(err);
    } else {
      sessionErrors.push(err);
    }
  }
  for (var i = 0; i < messages.length; i++) {
    chunks.push(renderMessage(messages[i]));
    // Render message-level errors after the message
    var mid = messages[i].info && messages[i].info.id;
    if (mid && msgErrors[mid]) {
      for (var mi = 0; mi < msgErrors[mid].length; mi++) {
        chunks.push(renderErrorCard(msgErrors[mid][mi].message, msgErrors[mid][mi].actions));
      }
    }
  }
  for (var i = 0; i < diffs.length; i++) {
    var d = diffs[i];
    if (d.files && d.files.length > 0) {
      chunks.push(renderSessionDiff(d));
    }
  }
  // Session-level errors at the end
  for (var i = 0; i < sessionErrors.length; i++) {
    chunks.push(renderErrorCard(sessionErrors[i].message, sessionErrors[i].actions));
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
  var errName = info.error.name || '';
  var errMsg = errorText(info.error);
  // Abort is a user-initiated interrupt, not a real error — show as subtle line
  if (errName === 'MessageAbortedError' || errName === 'AbortError' ||
      errMsg.indexOf('MessageAbortedError') !== -1 ||
      errMsg.indexOf('Tool execution aborted') !== -1 ||
      errMsg.trim().toLowerCase() === 'aborted') {
    return '<div class="step-line"><span class="step-icon">&#x25A0;</span><span class="step-text">interrupted</span></div>';
  }
  return renderErrorCard(errMsg);
}

/* ── Debug flag: set to true to show all parts (step-start, step-finish, etc.) ── */
var SHOW_DETAILS = false;

/* ── Part routing (aligned with TUI PART_MAPPING: text, tool, reasoning only) ── */
function renderPart(part) {
  if (!part) return '';
  switch (part.type) {
    case 'text':
      if (part.synthetic) return renderSyntheticContext(part.text || '');
      return '<div class="part text">' + renderMarkdown(part.text || '') + '</div>';
    case 'reasoning':
      return renderReasoning(part);
    case 'tool':
      if (part.tool === 'question') {
        return renderQuestionTool(part);
      }
      return renderTool(part);
    case 'step-start':
      if (SHOW_DETAILS) return renderStepStart(part);
      return '';
    case 'step-finish':
      if (SHOW_DETAILS) return renderStepFinish(part);
      return '';
    case 'retry':
      return renderRetry(part);
    case 'patch':
      if (SHOW_DETAILS) return renderPatch(part);
      return '';
    case 'file':
      return renderFile(part);
    case 'agent':
      if (SHOW_DETAILS) return renderAgentCard(part);
      return '';
    case 'subtask':
      if (SHOW_DETAILS) return renderSubtask(part);
      return '';
    case 'checkpoint':
      if (SHOW_DETAILS) return renderCheckpoint(part);
      return '';
    case 'compaction':
      if (SHOW_DETAILS) return renderCompaction(part);
      return '';
    case 'snapshot':
      if (SHOW_DETAILS) return renderSnapshot(part);
      return '';
    default:
      if (SHOW_DETAILS) return renderCollapsible(part.type || 'part', JSON.stringify(part, null, 2), 'part');
      return '';
  }
}

/* ── Tool rendering (aligned with TUI InlineTool/BlockTool pattern) ── */
var SIMPLE_TOOLS = {
  glob: { icon: '&#x2731;', label: 'Glob' },
  grep: { icon: '&#x2731;', label: 'Grep' },
  read: { icon: '&#x2192;', label: 'Read' },
  webfetch: { icon: '%', label: 'WebFetch' },
  codesearch: { icon: '&#x25C7;', label: 'Code Search' },
  websearch: { icon: '&#x25C8;', label: 'Web Search' },
  skill: { icon: '&#x2192;', label: 'Skill' },
  task: { icon: '#', label: 'Task' },
  plan_exit: { icon: '&#x2699;', label: 'Plan exit' }
};

function renderTool(part) {
  var s = part.state || {};
  var status = s.status || 'pending';
  var toolName = part.tool || 'tool';

  // Hide completed tools with no error (TUI: shouldHide when showDetails=false)
  if (!SHOW_DETAILS && status === 'completed' && !s.error) {
    return '';
  }

  // Simple tools: inline one-liner
  var simpleDef = SIMPLE_TOOLS[toolName];
  if (simpleDef) {
    return renderInlineTool(part, simpleDef);
  }

  // Complex tools (bash, write, edit, apply_patch, etc.): collapsible block card
  return renderBlockTool(part);
}

/* ── Inline tool: single-line display (TUI InlineTool) ── */
function renderInlineTool(part, def) {
  var s = part.state || {};
  var status = s.status || 'pending';
  var icon = def.icon;
  var label = def.label;

  // Build description from input
  var desc = '';
  if (s.input) {
    if (s.input.pattern) desc = '"' + truncate(s.input.pattern, 40) + '"';
    else if (s.input.filePath) desc = truncate(s.input.filePath, 40);
    else if (s.input.query) desc = '"' + truncate(s.input.query, 40) + '"';
    else if (s.input.url) desc = truncate(s.input.url, 40);
    else if (s.input.name) desc = '"' + truncate(s.input.name, 40) + '"';
    else if (s.input.command) desc = truncate(s.input.command, 40);
  }

  // Metadata summary (e.g. match count)
  var meta = '';
  if (s.metadata) {
    if (s.metadata.count) meta = ' (' + s.metadata.count + ' match' + (s.metadata.count !== 1 ? 'es' : '') + ')';
    else if (s.metadata.matches) meta = ' (' + s.metadata.matches + ' match' + (s.metadata.matches !== 1 ? 'es' : '') + ')';
    else if (s.metadata.numResults) meta = ' (' + s.metadata.numResults + ' results)';
  }

  if (status === 'running') {
    return '<div class="inline-tool">' +
      '<span class="inline-tool-icon">&#x23F3;</span> ' +
      '<span class="inline-tool-label">' + escapeHtml(label) + '</span>' +
      (desc ? ' <span class="inline-tool-desc">' + escapeHtml(desc) + '</span>' : '') +
    '</div>';
  }

  if (status === 'error') {
    var errMsg = s.error || 'error';
    return '<div class="inline-tool inline-tool-error">' +
      '<span class="inline-tool-icon">&#x2717;</span> ' +
      '<span class="inline-tool-label">' + escapeHtml(label) + '</span>' +
      (desc ? ' <span class="inline-tool-desc">' + escapeHtml(desc) + '</span>' : '') +
      '<span class="inline-tool-meta">' + escapeHtml(truncate(errMsg, 60)) + '</span>' +
    '</div>';
  }

  // completed or pending
  return '<div class="inline-tool">' +
    '<span class="inline-tool-icon">' + icon + '</span> ' +
    '<span class="inline-tool-label">' + escapeHtml(label) + '</span>' +
    (desc ? ' <span class="inline-tool-desc">' + escapeHtml(desc) + '</span>' : '') +
    (meta ? '<span class="inline-tool-meta">' + escapeHtml(meta) + '</span>' : '') +
  '</div>';
}

/* ── Block tool: collapsible card for complex tools (TUI BlockTool) ── */
function renderBlockTool(part) {
  var s = part.state || {};
  var status = s.status || 'pending';
  var toolName = part.tool || 'tool';
  var title = s.title || toolName;
  var icon = status === 'running' ? '&#x23F3;' : status === 'error' ? '&#x2717;' : '&#x25CB;';
  var badgeClass = status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'pending';
  var body = s.output || s.error || s.raw || '';
  var openAttr = status === 'running' || status === 'error' ? ' open' : '';

  // Build a compact header: tool name + key input param
  var header = toolName;
  if (s.input) {
    if (s.input.command) header = '$ ' + truncate(s.input.command, 50);
    else if (s.input.filePath) header = toolName + ' ' + truncate(s.input.filePath, 40);
    else if (s.input.description) header = truncate(s.input.description, 50);
  }

  var summaryLine = '';
  if (s.input && s.input.command && toolName === 'bash') {
    summaryLine = '<div class="card-summary">' + escapeHtml('$ ' + s.input.command) + '</div>';
  }

  return '<details class="card"' + openAttr + '>' +
    '<summary class="card-row">' +
      '<span class="card-icon">' + icon + '</span>' +
      '<span class="card-title">' + escapeHtml(header) + '</span>' +
      '<span class="card-badge ' + badgeClass + '">' + escapeHtml(status) + '</span>' +
    '</summary>' +
    summaryLine +
    (body ? '<div class="card-detail"><pre>' + escapeHtml(truncate(body, 2000)) + '</pre></div>' : '') +
  '</details>';
}

/* ── Question tool (aligned with TUI: pending=interactive, answered=collapsed) ── */
function renderQuestionTool(part) {
  var s = part.state || {};
  var status = s.status || 'pending';
  var input = s.input || {};
  var questions = input.questions || [];
  var toolCallId = part.callID || '';
  var messageId = part.messageID || '';
  var sessionId = part.sessionID || '';
  var requestID = part._questionRequestID || '';
  var answered = status === 'completed' || status === 'error';

  // Answered questions: collapsed one-liner (TUI: InlineTool "Asked N questions")
  if (answered) {
    var count = questions.length || 0;
    var answers = s.metadata && s.metadata.answers;
    var answerSummary = '';
    if (answers && Array.isArray(answers)) {
      var parts = [];
      for (var ai = 0; ai < answers.length; ai++) {
        if (answers[ai] && answers[ai].length) parts.push(answers[ai].join(', '));
      }
      answerSummary = parts.length ? ': ' + truncate(parts.join('; '), 60) : '';
    }
    return '<div class="inline-tool">' +
      '<span class="inline-tool-icon">&#x2753;</span> ' +
      '<span class="inline-tool-label">Asked ' + count + ' question' + (count !== 1 ? 's' : '') + '</span>' +
      (answerSummary ? '<span class="inline-tool-meta">' + escapeHtml(answerSummary) + '</span>' : '') +
    '</div>';
  }

  // Pending questions: full interactive card
  var chunks = [];
  chunks.push('<div class="card question-card">');
  chunks.push('<div class="card-row">');
  chunks.push('<span class="card-icon">&#x2753;</span>');
  chunks.push('<span class="card-title">Question</span>');
  chunks.push('<span class="card-badge pending">pending</span>');
  chunks.push('</div>');

  for (var qi = 0; qi < questions.length; qi++) {
    var q = questions[qi];
    var qheader = q.header || '';
    var questionText = q.question || '';
    var options = q.options || [];

    if (qheader) {
      chunks.push('<div class="question-header">' + escapeHtml(qheader) + '</div>');
    }
    if (questionText) {
      chunks.push('<div class="question-text">' + escapeHtml(questionText) + '</div>');
    }

    if (options.length > 0) {
      chunks.push('<div class="question-options">');
      for (var oi = 0; oi < options.length; oi++) {
        var opt = options[oi];
        var optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
        var optDesc = typeof opt === 'object' ? (opt.description || opt.hint || '') : '';
        var optValue = typeof opt === 'object' ? (opt.label || opt.value || '') : opt;
        chunks.push('<button class="question-opt-btn" data-action="answerQuestion" data-answer="' + escapeAttr(optValue) + '" data-tool-call-id="' + escapeAttr(toolCallId) + '" data-message-id="' + escapeAttr(messageId) + '" data-session-id="' + escapeAttr(sessionId) + '" data-request-id="' + escapeAttr(requestID) + '">' + escapeHtml(optLabel) + (optDesc ? '<span class="question-opt-desc">' + escapeHtml(optDesc) + '</span>' : '') + '</button>');
      }
      chunks.push('</div>');
    } else {
      chunks.push('<div class="question-text-input">');
      chunks.push('<input type="text" class="question-input" placeholder="Type your answer..." data-tool-call-id="' + escapeAttr(toolCallId) + '" data-message-id="' + escapeAttr(messageId) + '" data-session-id="' + escapeAttr(sessionId) + '" data-request-id="' + escapeAttr(requestID) + '" />');
      chunks.push('<button class="question-submit-btn" data-action="answerQuestionInput" data-tool-call-id="' + escapeAttr(toolCallId) + '" data-message-id="' + escapeAttr(messageId) + '" data-session-id="' + escapeAttr(sessionId) + '" data-request-id="' + escapeAttr(requestID) + '">Submit</button>');
      chunks.push('</div>');
    }
  }

  chunks.push('</div>');
  return chunks.join('');
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

/* ── Reasoning (aligned with TUI: collapsed Thought · duration, click to expand) ── */
function renderReasoning(part) {
  var text = (part.text || '').replace('[REDACTED]', '').trim();
  if (!text) return '';

  var isDone = part.time && part.time.end !== undefined;
  var duration = 0;
  if (isDone && part.time) {
    duration = Math.max(0, part.time.end - part.time.start);
  }

  // Extract title from leading **bold** pattern (same as TUI reasoningSummary)
  var title = null;
  var body = text;
  var titleMatch = text.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (titleMatch) {
    title = titleMatch[1].trim();
    body = text.slice(titleMatch[0].length).trimEnd();
  }

  var durationStr = duration > 0 ? formatDuration(duration) : '';
  var summaryLabel = 'Thought';
  if (title || durationStr) {
    summaryLabel += ' · ';
    if (title) summaryLabel += title;
    if (title && durationStr) summaryLabel += ' · ';
    if (durationStr) summaryLabel += durationStr;
  }

  // If thinking is still in progress
  if (!isDone) {
    return '<div class="reasoning-summary">' +
      '<span class="reasoning-icon">&#x23F3;</span> ' +
      '<span class="reasoning-label">Thinking' + (title ? ': ' + escapeHtml(title) : '') + '</span>' +
    '</div>';
  }

  return '<details class="reasoning-summary">' +
    '<summary><span class="reasoning-icon">&#x1F4AD;</span> ' + escapeHtml(summaryLabel) + '</summary>' +
    '<div class="reasoning-body"><pre>' + escapeHtml(body) + '</pre></div>' +
  '</details>';
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
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

/* ── Synthetic context chip (e.g. "Current file: @/path") ── */
function renderSyntheticContext(text) {
  // Extract file path from patterns like "Current file: @/absolute/path" or "Selection from @path#L1-5:"
  var fileMatch = text.match(/Current file: @(.+?)$/);
  if (fileMatch) {
    var fullPath = fileMatch[1].trim();
    var basename = fullPath.split(/[\\/]/).pop() || fullPath;
    // Try to show workspace-relative path
    var relPath = fullPath;
    var workspaceMatch = fullPath.match(/(?:^|\/)([^/]+\/.+)$/);
    if (workspaceMatch) relPath = workspaceMatch[1];
    return '<div class="context-chip" title="' + escapeAttr(fullPath) + '">&#x1F4C4; ' + escapeHtml(basename) + '</div>';
  }
  var selMatch = text.match(/Selection from @(.+?)(?:#|$)/);
  if (selMatch) {
    var selPath = selMatch[1].trim();
    var selBasename = selPath.split(/[\\/]/).pop() || selPath;
    return '<div class="context-chip" title="' + escapeAttr(selPath) + '">&#x1F4CB; ' + escapeHtml(selBasename) + '</div>';
  }
  // Fallback: render as compact text
  return '<div class="context-chip">' + escapeHtml(truncate(text, 80)) + '</div>';
}

/* ── Error card ── */
function renderErrorCard(message, actions) {
  var html = '<div class="error-card">' + escapeHtml(message);
  if (actions && actions.length > 0) {
    html += '<div class="error-actions">';
    for (var ai = 0; ai < actions.length; ai++) {
      html += '<button class="error-action-btn" data-action="' + escapeAttr(actions[ai].action) + '">' + escapeHtml(actions[ai].label) + '</button>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
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

/* ── Question input enter key ── */
els.timeline.addEventListener('keydown', function(event) {
  if (event.key === 'Enter' && event.target.classList.contains('question-input')) {
    event.preventDefault();
    var card = event.target.closest('.question-card');
    var submitBtn = card ? card.querySelector('.question-submit-btn') : null;
    if (submitBtn) submitBtn.click();
  }
});

vscode.postMessage({ type: 'ready' });`;
}
