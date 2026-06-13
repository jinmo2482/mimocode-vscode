export function getStyles(): string {
    return String.raw`
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; width: 100%; overflow: hidden; }

body {
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  flex-shrink: 0;
  min-width: 0;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  flex-shrink: 0;
  transition: background 0.3s;
}
.status-dot.connected { background: var(--vscode-testing-iconPassed); }
.status-dot.retrying, .status-dot.connecting {
  background: var(--vscode-testing-iconQueued);
  animation: pulse 1.5s infinite;
}
.status-dot.error { background: var(--vscode-testing-iconFailed); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

#session-select {
  flex: 1;
  min-width: 0;
  max-width: 200px;
  font-size: inherit;
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px; height: 22px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}
.header-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.header-btn:disabled { opacity: 0.3; cursor: default; }
.meta-chips {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  flex-shrink: 1;
  min-width: 0;
}
.chip {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 6px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 99px;
  line-height: 1.5;
  flex-shrink: 1;
  min-width: 0;
}

/* ── Login screen ── */
.login-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0;
  overflow-y: auto;
}
.login-screen.hidden { display: none; }
.login-card {
  text-align: center;
  width: min(90%, 320px);
  padding: 28px 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 12px;
  background: var(--vscode-editor-background);
}
.login-logo {
  font-size: 40px;
  margin-bottom: 12px;
  color: var(--vscode-textLink-foreground);
  line-height: 1;
}
.login-card h2 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.login-card p {
  margin: 0 0 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
  line-height: 1.5;
}
.login-btn {
  width: 100%;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  margin-bottom: 12px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: none;
  cursor: pointer;
}
.login-btn:hover { background: var(--vscode-button-hoverBackground); }
.login-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin: 0;
  opacity: 0.7;
}

/* ── Timeline ── */
.timeline {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  min-height: 0;
  word-break: break-word;
  scroll-behavior: smooth;
}

/* ── Empty state ── */
.empty {
  color: var(--vscode-descriptionForeground);
  padding: 32px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-icon { font-size: 28px; opacity: 0.5; line-height: 1; }
.empty-text { font-size: 13px; line-height: 1.5; max-width: 240px; }

/* ── Messages (transcript style) ── */
.message {
  padding: 6px 8px;
  margin-bottom: 2px;
  min-width: 0;
  border-radius: 4px;
}
.message.user {
  background: var(--vscode-input-background);
  border-radius: 6px;
}
.message.assistant { background: transparent; }
.msg-role {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.msg-role .msg-time {
  font-weight: 400;
  opacity: 0.6;
}
.msg-role .msg-agent {
  font-weight: 400;
  font-size: 10px;
  padding: 0 5px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 99px;
  color: var(--vscode-textLink-foreground);
}
.msg-body { min-width: 0; overflow: hidden; }

/* ── Parts ── */
.part { margin: 4px 0; }
.part:first-child { margin-top: 0; }
.text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}
.text code {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 3px;
}
.text strong { font-weight: 600; }

/* ── Collapsible (reasoning, subtask, retry) ── */
.collapsible summary {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
  padding: 2px 0;
  user-select: none;
  list-style: none;
}
.collapsible summary::-webkit-details-marker { display: none; }
.collapsible summary::before {
  content: '▶';
  display: inline-block;
  width: 12px;
  font-size: 9px;
  margin-right: 4px;
  transition: transform 0.15s;
  color: var(--vscode-descriptionForeground);
}
.collapsible[open] > summary::before { transform: rotate(90deg); }
.collapsible summary:hover { text-decoration: underline; }

/* ── Card (tool, checkpoint, patch, agent, file) ── */
.card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  background: var(--vscode-editor-background);
  margin: 4px 0;
  min-width: 0;
  overflow: hidden;
}
.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 12px;
  min-width: 0;
  cursor: default;
}
.card-row.clickable { cursor: pointer; }
.card-row.clickable:hover { background: var(--vscode-list-hoverBackground); }
.card-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
  line-height: 1;
}
.card-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.card-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 99px;
  line-height: 1.6;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}
.card-badge.pending { border-color: var(--vscode-panel-border); }
.card-badge.running {
  border-color: var(--vscode-testing-iconQueued);
  color: var(--vscode-testing-iconQueued);
}
.card-badge.completed {
  border-color: var(--vscode-testing-iconPassed);
  color: var(--vscode-testing-iconPassed);
}
.card-badge.error {
  border-color: var(--vscode-testing-iconFailed);
  color: var(--vscode-testing-iconFailed);
}
.card-summary {
  padding: 0 8px 5px 30px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-detail {
  padding: 0 8px 6px 8px;
}
.card-detail pre {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  padding: 6px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background);
  font-size: 0.85em;
  line-height: 1.45;
  max-height: 200px;
  overflow-y: auto;
  max-width: 100%;
}
.card-detail code {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}
.card-actions {
  display: flex;
  gap: 4px;
  padding: 4px 8px 6px 30px;
}
.card-actions button,
.card-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  line-height: 1.4;
}
.card-actions button:hover,
.card-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* ── Step line (step-start, step-finish, compaction, snapshot) ── */
.step-line {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 8px;
  margin: 2px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.step-line .step-icon {
  flex-shrink: 0;
  font-size: 11px;
  width: 14px;
  text-align: center;
}
.step-line .step-text { flex: 1; min-width: 0; }
.step-line .step-meta {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.6;
}

/* ── Context chip (synthetic file/selection context) ── */
.context-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 99px;
  padding: 1px 8px;
  margin: 2px 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Error card ── */
.error-card {
  border-left: 3px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, var(--vscode-editor-background));
  border-radius: 0 5px 5px 0;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.4;
  margin: 4px 0;
}
.error-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.error-action-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  background: transparent;
  color: var(--vscode-errorForeground);
  cursor: pointer;
  line-height: 1.4;
  transition: all 0.15s;
}
.error-action-btn:hover {
  background: var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-button-foreground);
}

/* ── Diff card ── */
.diff-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  background: var(--vscode-editor-background);
  margin: 4px 0;
  min-width: 0;
  overflow: hidden;
}
.diff-card .diff-files {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 0 8px 6px 30px;
}
.diff-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px 8px 6px 30px;
}
.diff-actions button {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
}
.diff-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }

/* ── Mentions dropdown ── */
.mentions {
  max-height: min(180px, 30vh);
  overflow-y: auto;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-dropdown-background);
  flex-shrink: 0;
}
.mentions.hidden { display: none; }
.mention-item {
  padding: 5px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 13px;
}
.mention-item:hover { background: var(--vscode-list-hoverBackground); }
.mention-item:last-child { border-bottom: none; }
.mention-path {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

/* ── Composer ── */
.composer {
  padding: 6px 8px 8px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  flex-shrink: 0;
}

/* ── Agent mode bar ── */
.agent-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
}
.agent-pill {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 99px;
  border: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  line-height: 1.5;
  transition: all 0.15s;
}
.agent-pill:hover {
  border-color: var(--vscode-focusBorder);
  color: var(--vscode-foreground);
}
.agent-pill.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

/* ── Control row (model + variant selects) ── */
.control-row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  align-items: center;
}
.control-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.control-select {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
  max-width: 180px;
  text-overflow: ellipsis;
  cursor: pointer;
  outline: none;
}
.control-select:focus {
  border-color: var(--vscode-focusBorder);
}
.control-select:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Composer input ── */
.composer-input-wrap {
  position: relative;
  border: 1px solid var(--vscode-input-border);
  border-radius: 6px;
  background: var(--vscode-input-background);
  transition: border-color 0.15s;
}
.composer-input-wrap:focus-within {
  border-color: var(--vscode-focusBorder);
}
#prompt {
  width: 100%;
  min-height: 36px;
  max-height: 200px;
  resize: none;
  padding: 8px 10px;
  padding-right: 60px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  outline: none;
  overflow-y: auto;
}
.composer-actions {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.send-btn, .abort-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  min-width: 24px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
.send-btn:hover { background: var(--vscode-button-hoverBackground); }
.send-btn:disabled { opacity: 0.3; cursor: default; }
.abort-btn {
  color: var(--vscode-errorForeground);
  background: transparent;
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}
.abort-btn:hover { background: var(--vscode-inputValidation-errorBackground); }
.abort-btn.hidden { display: none; }
.composer-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
  opacity: 0.6;
}

/* ── Question tool ── */
.question-card { padding-bottom: 6px; }
.question-card.answered { opacity: 0.7; }
.question-header {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px 0 30px;
}
.question-text {
  font-size: 12px;
  padding: 2px 8px 4px 30px;
  color: var(--vscode-foreground);
}
.question-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 8px 2px 30px;
}
.question-opt-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  line-height: 1.4;
  text-align: left;
}
.question-opt-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.question-opt-desc {
  display: block;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-top: 1px;
}
.question-text-input {
  display: flex;
  gap: 4px;
  padding: 2px 8px 2px 30px;
  align-items: center;
}
.question-input {
  flex: 1;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  outline: none;
}
.question-input:focus { border-color: var(--vscode-focusBorder); }
.question-submit-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  line-height: 1.4;
}
.question-submit-btn:hover { background: var(--vscode-button-hoverBackground); }

/* ── Reasoning summary (collapsed Thought line) ── */
.reasoning-summary {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 0;
  margin: 2px 0;
  cursor: pointer;
  user-select: none;
}
.reasoning-summary summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.reasoning-summary summary::-webkit-details-marker { display: none; }
.reasoning-summary summary::before {
  content: '▶';
  display: inline-block;
  width: 12px;
  font-size: 9px;
  transition: transform 0.15s;
  color: var(--vscode-descriptionForeground);
}
.reasoning-summary[open] > summary::before { transform: rotate(90deg); }
.reasoning-summary summary:hover { color: var(--vscode-textLink-foreground); }
.reasoning-icon { flex-shrink: 0; }
.reasoning-label { font-weight: 500; }
.reasoning-duration { opacity: 0.6; }
.reasoning-body {
  padding: 4px 0 4px 16px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}
.reasoning-body pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: inherit;
}

/* ── Inline tool (single-line, TUI InlineTool) ── */
.inline-tool {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 1px 0;
  margin: 1px 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
.inline-tool-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}
.inline-tool-label {
  font-weight: 500;
  white-space: nowrap;
}
.inline-tool-desc {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.inline-tool-meta {
  opacity: 0.5;
  font-size: 11px;
  white-space: nowrap;
}
.inline-tool-error {
  color: var(--vscode-errorForeground);
}

/* ── Hidden utility ── */
.hidden { display: none; }
`;
}
