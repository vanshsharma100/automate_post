// Minimal progressive enhancement (CSP-safe, served from /public).
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-confirm]');
  if (el && !confirm(el.getAttribute('data-confirm'))) {
    e.preventDefault();
  }
});

// Tabbed sections (Share Knowledge: shared + one pane per platform).
document.addEventListener('click', function (e) {
  var tab = e.target.closest('.tab[data-tab]');
  if (!tab) return;
  var group = tab.closest('form') || document;
  var name = tab.getAttribute('data-tab');
  group.querySelectorAll('.tab[data-tab]').forEach(function (t) {
    t.classList.toggle('active', t === tab);
  });
  group.querySelectorAll('.tabpane[data-pane]').forEach(function (p) {
    p.classList.toggle('active', p.getAttribute('data-pane') === name);
  });
});

// Schedule: add / remove posting times (many times per day).
document.addEventListener('click', function (e) {
  var add = e.target.closest('[data-add-time]');
  if (add) {
    var key = add.getAttribute('data-add-time');
    var box = document.querySelector('[data-times="' + key + '"]');
    if (!box) return;
    var wrap = document.createElement('span');
    wrap.className = 'timeitem';
    var input = document.createElement('input');
    input.type = 'time';
    input.name = key + '_times';
    input.value = '18:00';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn ghost sm danger';
    del.setAttribute('data-remove-time', '');
    del.title = 'Remove this time';
    del.textContent = '✕';
    wrap.appendChild(input);
    wrap.appendChild(del);
    box.appendChild(wrap);
    return;
  }
  var rm = e.target.closest('[data-remove-time]');
  if (rm) {
    var item = rm.closest('.timeitem');
    var parent = item && item.parentNode;
    // Always leave at least one time input.
    if (parent && parent.querySelectorAll('.timeitem').length > 1) item.remove();
  }
});

// Add-account form: show only the ID fields the chosen platform needs.
function syncPlatformFields(sel) {
  var form = sel.closest('form');
  if (!form) return;
  form.querySelectorAll('.pf').forEach(function (g) {
    g.classList.toggle('show', g.classList.contains('pf-' + sel.value));
  });
}
document.addEventListener('change', function (e) {
  var sel = e.target.closest('[data-platform-select]');
  if (sel) syncPlatformFields(sel);
});
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-platform-select]').forEach(syncPlatformFields);
});

// Toggle secret input visibility on "reveal" buttons.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  var input = document.getElementById(btn.getAttribute('data-reveal'));
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
});

// Generator: hide the Product picker when the post type is "General".
function syncPostType(sel) {
  var form = sel.closest('form');
  if (!form) return;
  var general = sel.value === 'general';
  form.querySelectorAll('.product-field').forEach(function (g) {
    g.style.display = general ? 'none' : '';
  });
}
document.addEventListener('change', function (e) {
  var sel = e.target.closest('[data-posttype-select]');
  if (sel) syncPostType(sel);
});
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-posttype-select]').forEach(syncPostType);
});

// Content page: filter the drafts grid by platform (per-platform sections).
document.addEventListener('click', function (e) {
  var tab = e.target.closest('.tab[data-filter]');
  if (!tab) return;
  var want = tab.getAttribute('data-filter');
  document.querySelectorAll('.tab[data-filter]').forEach(function (t) {
    t.classList.toggle('active', t === tab);
  });
  document.querySelectorAll('[data-content-grid] .post-card').forEach(function (card) {
    var show = want === 'all' || card.getAttribute('data-platform') === want;
    card.style.display = show ? '' : 'none';
  });
});
