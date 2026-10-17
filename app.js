(function () {
  const chat = document.getElementById('chat-box');
  if (!chat) return;

  let last = parseInt(chat.dataset.last || '0', 10);
  const form = document.getElementById('chat-form');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function append(msgs) {
    let added = false;
    msgs.forEach(m => {
      if (m.id <= last) return;
      last = m.id; added = true;
      const div = document.createElement('div');
      div.className = 'msg' + (m.source === 'roblox' ? ' roblox' : '');
      div.innerHTML =
        '<span class="who">' + esc(m.username) + '</span>' +
        '<span class="txt">' + esc(m.message) + '</span>' +
        '<span class="time">' + esc((m.created_at || '').substr(11, 5)) + '</span>';
      chat.appendChild(div);
    });
    if (added) chat.scrollTop = chat.scrollHeight;
  }

  function poll() {
    fetch('index.php?page=api&type=messages&since=' + last)
      .then(r => r.json()).then(append).catch(() => {});
  }

  chat.scrollTop = chat.scrollHeight;
  setInterval(poll, 3000);

  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const input = form.querySelector('input[name="message"]');
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      const fd = new FormData(form);
      fd.append('ajax', '1');
      fetch('index.php', { method: 'POST', body: fd }).then(poll).catch(() => {});
    });
  }
})();