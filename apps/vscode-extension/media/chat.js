const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let active = false;
let reply = null;
function bubble(role, content) {
  const element = document.createElement('div');
  element.className = 'bubble ' + role;
  element.textContent = content;
  $('messages').appendChild(element);
  $('messages').scrollTop = $('messages').scrollHeight;
  return element;
}
function setBusy(value) {
  active = value;
  $('send').disabled = value;
  $('stop').disabled = !value;
  $('prompt').disabled = value;
}
function renderOptions(select, items, first, selected) {
  select.replaceChildren();
  const base = document.createElement('option');
  base.value = '';
  base.textContent = first;
  select.appendChild(base);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = selected || '';
}
$('send').onclick = () => {
  const prompt = $('prompt').value.trim();
  if (!prompt || active) return;
  $('error').textContent = '';
  $('prompt').value = '';
  vscode.postMessage({ type: 'send', prompt, mode: $('mode').value, modelId: $('model').value });
};
$('stop').onclick = () => vscode.postMessage({ type: 'stop' });
$('new').onclick = () => vscode.postMessage({ type: 'new' });
$('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
$('sessions').onchange = () => {
  if ($('sessions').value) vscode.postMessage({ type: 'load', sessionId: $('sessions').value });
};
$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('send').click();
};
window.addEventListener('message', event => {
  const { type, data } = event.data;
  if (type === 'state') {
    const old = $('model').value;
    renderOptions($('model'), data.models.map(model => ({ value: model.provider + '/' + model.id, label: model.provider + '/' + model.id })), 'Auto model', old);
    renderOptions($('sessions'), data.sessions.map(session => ({ value: session.id, label: session.title })), 'New session', data.current);
    $('usage').textContent = data.usage ? `Tokens: ${data.usage.inputTokens} in / ${data.usage.outputTokens} out · $${data.spentUsd.toFixed(4)}` : 'No usage yet';
  }
  if (type === 'history') {
    $('messages').replaceChildren();
    for (const message of data) bubble(message.role, message.content);
  }
  if (type === 'started') {
    bubble('user', data.prompt);
    reply = bubble('assistant', '');
    setBusy(true);
    $('progress').textContent = `Starting ${data.mode} task...`;
  }
  if (type === 'token') {
    if (reply) reply.textContent += data;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  if (type === 'progress') $('progress').textContent = `Step ${data.step}/${data.maxSteps}: ${data.message}`;
  if (type === 'done') {
    if (reply && !reply.textContent) reply.textContent = data.answer;
    $('progress').textContent = `Done · ${data.models.join(', ')}`;
    setBusy(false); reply = null;
  }
  if (type === 'notice') $('progress').textContent = data;
  if (type === 'error') { $('error').textContent = data; setBusy(false); reply = null; }
});
vscode.postMessage({ type: 'refresh' });
