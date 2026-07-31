const STORAGE_KEY = 'belial-trial-state-v1';
const VERSION = 1;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const app = $('#app');
const toast = $('#toast');
const importFile = $('#importFile');

const tpl = {
  home: $('#tpl-home').innerHTML,
  editor: $('#tpl-editor').innerHTML,
  battle: $('#tpl-battle').innerHTML,
};

let state = loadState();
let undoStack = [];
let activeModalParticipantId = null;
let longPressTimer = null;
let persistTimer = null;
let pendingBattleSearch = '';
let pendingHomeSearch = '';
let pendingEditorSearch = '';

function defaultState() {
  return {
    version: VERSION,
    view: 'home',
    activeCombatId: null,
    combats: [],
    favorites: [],
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState();
    return {
      ...defaultState(),
      ...parsed,
      combats: Array.isArray(parsed.combats) ? parsed.combats : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    };
  } catch (err) {
    console.warn('Load error', err);
    return defaultState();
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 80);
}

function snapshot() {
  undoStack.push(deepClone({
    version: state.version,
    view: state.view,
    activeCombatId: state.activeCombatId,
    combats: state.combats,
    favorites: state.favorites,
  }));
  if (undoStack.length > 30) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return notify('Nessuna modifica da annullare');
  state.version = prev.version || VERSION;
  state.view = prev.view || state.view;
  state.activeCombatId = prev.activeCombatId ?? state.activeCombatId;
  state.combats = prev.combats || [];
  state.favorites = prev.favorites || [];
  schedulePersist();
  render();
  notify('Ultima modifica annullata');
}

function notify(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(notify._t);
  notify._t = setTimeout(() => toast.classList.add('hidden'), 1700);
}

function uid(prefix='id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function nowIso() {
  return new Date().toISOString();
}

function getActiveCombat() {
  return state.combats.find(c => c.id === state.activeCombatId) || null;
}

function sortParticipants(combat) {
  combat.participants.sort((a, b) => {
    if ((b.initiative || 0) !== (a.initiative || 0)) return (b.initiative || 0) - (a.initiative || 0);
    return (a.name || '').localeCompare(b.name || '', 'it');
  });
}

function sortCombat(combat) {
  sortParticipants(combat);
  if (typeof combat.turnIndex !== 'number') combat.turnIndex = 0;
  if (combat.turnIndex >= combat.participants.length) combat.turnIndex = 0;
}

function normalizeParticipant(p) {
  return {
    id: p.id || uid('p'),
    favKey: p.favKey || p.id || null,
    name: p.name || 'Senza nome',
    role: p.role || 'npc',
    hp: Math.max(0, Number.isFinite(Number(p.hp)) ? Number(p.hp) : 0),
    maxHp: Math.max(0, Number.isFinite(Number(p.maxHp)) ? Number(p.maxHp) : Math.max(0, Number(p.hp) || 0)),
    initiative: Number.isFinite(Number(p.initiative)) ? Number(p.initiative) : 0,
    note: p.note || '',
    favorite: !!p.favorite,
  };
}

function normalizeCombat(c) {
  const combat = {
    id: c.id || uid('c'),
    name: c.name || 'Nuovo combattimento',
    notes: c.notes || '',
    createdAt: c.createdAt || nowIso(),
    updatedAt: nowIso(),
    started: !!c.started,
    round: Number.isFinite(Number(c.round)) ? Number(c.round) : 1,
    turnIndex: Number.isFinite(Number(c.turnIndex)) ? Number(c.turnIndex) : 0,
    participants: Array.isArray(c.participants) ? c.participants.map(normalizeParticipant) : [],
    search: c.search || '',
  };
  sortCombat(combat);
  return combat;
}

function ensureStateShape() {
  state.version = VERSION;
  state.view = state.view || 'home';
  state.activeCombatId = state.activeCombatId || null;
  state.combats = Array.isArray(state.combats) ? state.combats.map(normalizeCombat) : [];
  state.favorites = Array.isArray(state.favorites) ? state.favorites.map(normalizeParticipant) : [];
}

function favoriteKey(p) {
  return p.favKey || p.id || `${(p.name || '').trim().toLowerCase()}|${p.role || 'npc'}`;
}

function syncFavoritesFromCombatParticipant(p) {
  if (p.favorite) {
    if (!p.favKey) p.favKey = uid('fav');
    const template = {
      id: p.favKey,
      favKey: p.favKey,
      name: p.name,
      role: p.role,
      hp: p.hp,
      maxHp: p.maxHp,
      initiative: p.initiative,
      note: p.note || '',
      favorite: true,
    };
    const idx = state.favorites.findIndex(f => favoriteKey(f) === p.favKey);
    if (idx >= 0) state.favorites[idx] = template;
    else state.favorites.unshift(template);
  } else if (p.favKey) {
    state.favorites = state.favorites.filter(f => favoriteKey(f) !== p.favKey);
  }
}

function addCombat(opts = {}) {
  const combat = normalizeCombat({
    name: opts.name || `Combattimento ${state.combats.length + 1}`,
    participants: opts.participants || [],
    notes: '',
    started: false,
  });
  state.combats.unshift(combat);
  state.activeCombatId = combat.id;
  state.view = 'editor';
  schedulePersist();
  render();
  notify('Combattimento creato');
  return combat;
}

function removeCombat(id) {
  const combat = state.combats.find(c => c.id === id);
  if (!combat) return;
  if (!confirm(`Eliminare "${combat.name}"?`)) return;
  snapshot();
  state.combats = state.combats.filter(c => c.id !== id);
  if (state.activeCombatId === id) state.activeCombatId = state.combats[0]?.id || null;
  if (!state.combats.length) {
    state.activeCombatId = null;
    state.view = 'home';
  }
  schedulePersist();
  render();
  notify('Combattimento eliminato');
}

function duplicateCombat(id) {
  const combat = state.combats.find(c => c.id === id);
  if (!combat) return;
  snapshot();
  const copy = deepClone(combat);
  copy.id = uid('c');
  copy.name = combat.name + ' (copia)';
  copy.createdAt = nowIso();
  copy.updatedAt = nowIso();
  state.combats.unshift(normalizeCombat(copy));
  state.activeCombatId = state.combats[0].id;
  state.view = 'editor';
  schedulePersist();
  render();
  notify('Combattimento duplicato');
}

function currentCombatForEditor() {
  let combat = getActiveCombat();
  if (!combat) {
    combat = addCombat({ name: 'Nuovo combattimento', participants: [] });
  }
  return combat;
}

function addParticipantToCombat(combat, data, {silent=false} = {}) {
  if (!data.name?.trim()) {
    notify('Inserisci un nome');
    return null;
  }
  snapshot();
  const p = normalizeParticipant(data);
  combat.participants.push(p);
  sortCombat(combat);
  combat.updatedAt = nowIso();
  schedulePersist();
  if (!silent) render();
  return p;
}

function updateCombatFromInputs(combat) {
  const nameInput = $('#combatName');
  if (nameInput) combat.name = nameInput.value.trim() || combat.name;
  const battleName = $('#battleName');
  if (battleName) combat.name = battleName.value.trim() || combat.name;
}

function setView(view) {
  state.view = view;
  schedulePersist();
  render();
}

function activeCardIdForTurn(combat) {
  if (!combat.participants.length) return null;
  const idx = Math.max(0, Math.min(combat.turnIndex || 0, combat.participants.length - 1));
  return combat.participants[idx]?.id || null;
}

function participantClass(role) {
  return role === 'ally' ? 'role-ally' : role === 'enemy' ? 'role-enemy' : 'role-npc';
}

function roleLabel(role) {
  return role === 'ally' ? 'Alleato' : role === 'enemy' ? 'Nemico' : 'PNG';
}

function hpPercent(p) {
  const max = Math.max(0, Number(p.maxHp) || 0);
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(p.hp) || 0) / max * 100));
}

function hpFillClass(p) {
  const pct = hpPercent(p);
  if ((p.hp || 0) <= 0) return 'zero';
  if (pct <= 25) return 'danger';
  if (pct <= 50) return 'warn';
  return '';
}

function hpColorLabel(p) {
  if ((p.hp || 0) <= 0) return 'Sconfitto';
  const pct = hpPercent(p);
  if (pct <= 25) return 'Molto ferito';
  if (pct <= 50) return 'Ferito';
  return 'In salute';
}

function makeParticipantCard(p, combat, mode='battle') {
  const turnActive = activeCardIdForTurn(combat) === p.id;
  const zero = (p.hp || 0) <= 0;
  const el = document.createElement('div');
  el.className = `card ${turnActive ? 'active' : ''} ${zero ? 'zero' : ''}`;
  el.dataset.id = p.id;

  const hpMaxText = `${p.hp}/${p.maxHp || p.hp || 0} PF`;
  el.innerHTML = `
    <div class="card-inner">
      <div class="name-row">
        <span class="role-badge ${participantClass(p.role)}">${roleLabel(p.role)}</span>
        <div class="name">${escapeHtml(p.name)}</div>
        ${p.favorite ? '<span class="badge star on">★ Preferito</span>' : ''}
        ${turnActive ? '<span class="badge">Turno</span>' : ''}
      </div>
      <div class="details">
        <span>Init ${p.initiative || 0}</span>
        <span>•</span>
        <span>${escapeHtml(p.note || 'Nessuna nota')}</span>
        <span>•</span>
        <span>${hpColorLabel(p)}</span>
      </div>
      ${mode === 'battle' ? `
      <div class="card-actions">
        <button class="secondary compact" data-action="open-participant">Apri</button>
        <button class="secondary compact" data-action="toggle-favorite">${p.favorite ? '★' : '☆'}</button>
        <button class="secondary compact" data-action="quick-damage">-1</button>
        <button class="secondary compact" data-action="quick-heal">+1</button>
      </div>` : `
      <div class="card-actions">
        <button class="secondary compact" data-action="edit-participant">Modifica</button>
        <button class="secondary compact" data-action="toggle-favorite">${p.favorite ? '★' : '☆'}</button>
        <button class="secondary compact" data-action="delete-participant">Elimina</button>
      </div>`}
    </div>
    <div class="hp-block">
      <div class="hp-value" data-longpress="hp">${hpMaxText}</div>
      <div class="hp-bar"><div class="hp-fill ${hpFillClass(p)}" style="width:${hpPercent(p)}%"></div></div>
    </div>
  `;

  const hpValue = $('.hp-value', el);
  hpValue.addEventListener('pointerdown', (ev) => startLongPress(ev, p.id));
  hpValue.addEventListener('pointerup', cancelLongPress);
  hpValue.addEventListener('pointercancel', cancelLongPress);
  hpValue.addEventListener('pointerleave', cancelLongPress);

  el.addEventListener('click', (ev) => {
    const actionBtn = ev.target.closest('button');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'open-participant' || action === 'edit-participant') {
        openParticipantModal(p.id);
      } else if (action === 'toggle-favorite') {
        toggleParticipantFavorite(combat.id, p.id);
      } else if (action === 'quick-damage') {
        applyHpDelta(combat.id, p.id, -1);
      } else if (action === 'quick-heal') {
        applyHpDelta(combat.id, p.id, +1);
      } else if (action === 'delete-participant') {
        deleteParticipant(combat.id, p.id);
      }
      ev.stopPropagation();
      return;
    }
    openParticipantModal(p.id);
  });

  return el;
}

function render() {
  ensureStateShape();
  persist();
  app.innerHTML = '';
  const view = state.view;

  if (view === 'home') {
    app.appendChild(fragmentFromTemplate('home'));
    bindHome();
    renderHome();
    return;
  }
  if (view === 'editor') {
    app.appendChild(fragmentFromTemplate('editor'));
    bindEditor();
    renderEditor();
    return;
  }
  if (view === 'battle') {
    app.appendChild(fragmentFromTemplate('battle'));
    bindBattle();
    renderBattle();
    return;
  }
  state.view = 'home';
  render();
}

function fragmentFromTemplate(name) {
  const template = document.createElement('template');
  template.innerHTML = tpl[name].trim();
  return template.content.cloneNode(true);
}

function bindHome() {
  $('#homeSearch').value = pendingHomeSearch;
  $('#homeSearch').addEventListener('input', e => {
    pendingHomeSearch = e.target.value;
    renderHome();
  });
  $('[data-action="new-combat"]').addEventListener('click', () => {
    snapshot();
    const combat = addCombat({
      name: `Combattimento ${state.combats.length + 1}`,
      participants: state.favorites.map(f => ({ ...deepClone(f), id: uid('p'), favorite: true })),
    });
    state.activeCombatId = combat.id;
    state.view = 'editor';
    schedulePersist();
    render();
  });
  $('[data-action="import-all"]').addEventListener('click', () => importFile.click());
  $('[data-action="export-all"]').addEventListener('click', exportAll);
}

function renderHome() {
  const list = $('#combatList');
  const favList = $('#favoritesList');
  const search = (pendingHomeSearch || '').trim().toLowerCase();

  const combats = state.combats.filter(c => {
    const hay = `${c.name} ${c.notes} ${(c.participants || []).map(p => `${p.name} ${p.note}`).join(' ')}`.toLowerCase();
    return !search || hay.includes(search);
  });

  list.innerHTML = '';
  if (!combats.length) {
    list.innerHTML = `<div class="muted">Nessun combattimento salvato.</div>`;
  } else {
    combats.forEach(combat => {
      const el = document.createElement('div');
      el.className = 'item' + (combat.id === state.activeCombatId ? ' active' : '');
      el.innerHTML = `
        <div class="item-main">
          <div class="item-title">
            <strong>${escapeHtml(combat.name)}</strong>
            <span class="badge">${combat.participants.length} personaggi</span>
            ${combat.started ? '<span class="badge">In corso</span>' : '<span class="badge subtle">Preparazione</span>'}
          </div>
          <div class="item-sub">
            Round ${combat.round || 1} • ${combat.participants.length ? combat.participants.map(p => p.name).slice(0, 4).join(', ') : 'nessun partecipante'}
          </div>
        </div>
        <div class="card-actions">
          <button class="secondary compact" data-action="open-combat">Apri</button>
          <button class="secondary compact" data-action="duplicate-combat">Duplica</button>
          <button class="danger compact" data-action="delete-combat">Elimina</button>
        </div>
      `;
      el.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button');
        if (!btn) {
          openCombat(combat.id);
          return;
        }
        const action = btn.dataset.action;
        if (action === 'open-combat') openCombat(combat.id);
        if (action === 'duplicate-combat') duplicateCombat(combat.id);
        if (action === 'delete-combat') removeCombat(combat.id);
      });
      list.appendChild(el);
    });
  }

  const favorites = state.favorites;
  favList.innerHTML = '';
  if (!favorites.length) {
    favList.innerHTML = `<div class="muted">Nessun preferito ancora. Metti ★ a un personaggio e comparirà qui.</div>`;
  } else {
    favorites.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <div class="tiny">${roleLabel(f.role)} • Init ${f.initiative || 0} • ${f.hp || 0}/${f.maxHp || f.hp || 0} PF</div>
        </div>
        <button data-action="fav-add">Aggiungi</button>
      `;
      chip.querySelector('[data-action="fav-add"]').addEventListener('click', () => {
        const combat = getActiveCombat() || addCombat({ name: `Combattimento ${state.combats.length + 1}`, participants: [] });
        if (state.view !== 'editor' || state.activeCombatId !== combat.id) {
          state.activeCombatId = combat.id;
          state.view = 'editor';
        }
        snapshot();
        addParticipantToCombat(combat, { ...deepClone(f), id: uid('p'), favKey: f.favKey || f.id || uid('fav'), favorite: true }, { silent: true });
        schedulePersist();
        render();
        notify('Preferito aggiunto al combattimento');
      });
      favList.appendChild(chip);
    });
  }
}

function openCombat(id) {
  state.activeCombatId = id;
  const combat = getActiveCombat();
  if (!combat) return;
  state.view = combat.started ? 'battle' : 'editor';
  schedulePersist();
  render();
}

function bindEditor() {
  const combat = currentCombatForEditor();
  $('#combatName').value = combat.name;
  $('#combatName').addEventListener('input', e => {
    snapshot();
    combat.name = e.target.value;
    combat.updatedAt = nowIso();
    schedulePersist();
  });

  $('#pName').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#addParticipant').click();
  });
  $('#addParticipant').addEventListener('click', () => {
    const p = {
      name: $('#pName').value.trim(),
      hp: numValue('#pHp'),
      maxHp: numValue('#pHp'),
      initiative: numValue('#pInit'),
      role: $('#pRole').value,
      note: $('#pNote').value.trim(),
      favorite: false,
    };
    if (!p.name) return notify('Inserisci un nome');
    snapshot();
    addParticipantToCombat(combat, p);
    $('#pName').value = '';
    $('#pHp').value = '';
    $('#pInit').value = '';
    $('#pNote').value = '';
    $('#pName').focus();
  });

  $('#editorSearch').value = pendingEditorSearch;
  $('#editorSearch').addEventListener('input', e => {
    pendingEditorSearch = e.target.value;
    renderEditor();
  });

  $('[data-action="back-home"]').addEventListener('click', () => {
    updateCombatFromInputs(combat);
    state.view = 'home';
    schedulePersist();
    render();
  });
  $('[data-action="start-battle"]').addEventListener('click', () => {
    updateCombatFromInputs(combat);
    snapshot();
    sortCombat(combat);
    combat.started = true;
    combat.round = combat.round || 1;
    combat.turnIndex = 0;
    combat.updatedAt = nowIso();
    state.view = 'battle';
    schedulePersist();
    render();
    notify('Combattimento avviato');
  });
  $('[data-action="undo"]').addEventListener('click', undo);
}

function renderEditor() {
  const combat = currentCombatForEditor();
  $('#combatName').value = combat.name;
  const list = $('#editorList');
  const fav = $('#editorFavorites');
  const search = (pendingEditorSearch || '').trim().toLowerCase();

  const filtered = combat.participants.filter(p => {
    const hay = `${p.name} ${p.note} ${p.role}`.toLowerCase();
    return !search || hay.includes(search);
  });

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `<div class="muted">Nessun personaggio. Aggiungine uno sopra o usa i preferiti.</div>`;
  } else {
    filtered.forEach(p => {
      const el = makeParticipantCard(p, combat, 'editor');
      list.appendChild(el);
    });
  }

  const favorites = state.favorites;
  fav.innerHTML = '';
  if (!favorites.length) {
    fav.innerHTML = `<div class="muted">Metti ★ a un personaggio per salvarlo come preferito.</div>`;
  } else {
    favorites.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.innerHTML = `<strong>${escapeHtml(f.name)}</strong><span class="tiny">${roleLabel(f.role)} • Aggiungi</span>`;
      btn.addEventListener('click', () => {
        snapshot();
        addParticipantToCombat(combat, { ...deepClone(f), id: uid('p'), favorite: true });
        notify('Preferito aggiunto');
      });
      fav.appendChild(btn);
    });
  }
}

function bindBattle() {
  const combat = currentCombatForEditor();
  sortCombat(combat);
  $('#battleName').value = combat.name;
  $('#battleName').addEventListener('input', e => {
    snapshot();
    combat.name = e.target.value;
    combat.updatedAt = nowIso();
    schedulePersist();
    $('#battleName').value = combat.name;
  });

  $('#battleSearch').value = pendingBattleSearch;
  $('#battleSearch').addEventListener('input', e => {
    pendingBattleSearch = e.target.value;
    renderBattle();
  });

  $('[data-action="back-editor"]').addEventListener('click', () => {
    updateCombatFromInputs(combat);
    state.view = 'editor';
    schedulePersist();
    render();
  });
  $('[data-action="undo"]').addEventListener('click', undo);
  $('[data-action="next-turn"]').addEventListener('click', () => nextTurn(combat));
  $('[data-action="reset-turn"]').addEventListener('click', () => {
    snapshot();
    combat.turnIndex = 0;
    combat.round = 1;
    combat.updatedAt = nowIso();
    schedulePersist();
    render();
    notify('Turno resettato');
  });
}

function renderBattle() {
  const combat = currentCombatForEditor();
  sortCombat(combat);
  $('#battleName').value = combat.name;
  $('#roundBadge').textContent = `Round ${combat.round || 1}`;
  const current = combat.participants[combat.turnIndex] || null;
  $('#currentTurnLabel').textContent = current ? `${current.name} (${current.initiative || 0})` : 'Nessuno';
  $('#participantCount').textContent = `${combat.participants.length} pz`;

  const list = $('#battleList');
  const search = (pendingBattleSearch || '').trim().toLowerCase();
  const filtered = combat.participants.filter(p => {
    const hay = `${p.name} ${p.note} ${p.role}`.toLowerCase();
    return !search || hay.includes(search);
  });

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `<div class="muted">Nessun risultato. Cambia la ricerca o torna all'editor.</div>`;
  } else {
    filtered.forEach(p => list.appendChild(makeParticipantCard(p, combat, 'battle')));
  }

  $('[data-action="back-editor"]').onclick = () => {
    state.view = 'editor';
    schedulePersist();
    render();
  };
}

let modalAutosaveBound = false;

function openParticipantModal(participantId) {
  const combat = currentCombatForEditor();
  const p = combat.participants.find(x => x.id === participantId);
  if (!p) return;
  activeModalParticipantId = participantId;
  $('#editTitle').textContent = p.name;
  $('#editName').value = p.name;
  $('#editHp').value = p.hp;
  $('#editMaxHp').value = p.maxHp;
  $('#editInit').value = p.initiative;
  $('#editRole').value = p.role;
  $('#editNote').value = p.note || '';
  $('#editFavorite').checked = !!p.favorite;
  $('#modalHost').classList.remove('hidden');
  bindModalAutosave();
}

function bindModalAutosave() {
  if (modalAutosaveBound) return;
  modalAutosaveBound = true;
  const fields = ['#editName','#editHp','#editMaxHp','#editInit','#editRole','#editNote','#editFavorite'];
  fields.forEach(sel => {
    $(sel).addEventListener('input', () => {
      const combat = currentCombatForEditor();
      const p = combat.participants.find(x => x.id === activeModalParticipantId);
      if (!p) return;
      p.name = $('#editName').value.trim() || p.name;
      p.hp = clampNum($('#editHp').value, 0, 999999, p.hp);
      p.maxHp = clampNum($('#editMaxHp').value, 0, 999999, p.maxHp);
      if (p.maxHp < p.hp) p.maxHp = p.hp;
      p.initiative = clampNum($('#editInit').value, -9999, 9999, p.initiative);
      p.role = $('#editRole').value;
      p.note = $('#editNote').value.trim();
      p.favorite = $('#editFavorite').checked;
      syncFavoritesFromCombatParticipant(p);
      sortCombat(combat);
      combat.updatedAt = nowIso();
      schedulePersist();
      $('#editTitle').textContent = p.name;
    });
  });
}

function closeModal() {
  $('#modalHost').classList.add('hidden');
  activeModalParticipantId = null;
}

function saveParticipantFromModal() {
  const combat = currentCombatForEditor();
  const p = combat.participants.find(x => x.id === activeModalParticipantId);
  if (!p) return;
  snapshot();
  p.name = $('#editName').value.trim() || p.name;
  p.hp = clampNum($('#editHp').value, 0, 999999, p.hp);
  p.maxHp = clampNum($('#editMaxHp').value, 0, 999999, p.maxHp);
  if (p.maxHp < p.hp) p.maxHp = p.hp;
  p.initiative = clampNum($('#editInit').value, -9999, 9999, p.initiative);
  p.role = $('#editRole').value;
  p.note = $('#editNote').value.trim();
  p.favorite = $('#editFavorite').checked;
  syncFavoritesFromCombatParticipant(p);
  sortCombat(combat);
  combat.updatedAt = nowIso();
  schedulePersist();
  render();
  closeModal();
  notify('Personaggio salvato');
}

function deleteParticipant(combatId, participantId) {
  const combat = state.combats.find(c => c.id === combatId);
  if (!combat) return;
  const p = combat.participants.find(x => x.id === participantId);
  if (!p) return;
  if (!confirm(`Eliminare ${p.name}?`)) return;
  snapshot();
  combat.participants = combat.participants.filter(x => x.id !== participantId);
  if (combat.turnIndex >= combat.participants.length) combat.turnIndex = 0;
  combat.updatedAt = nowIso();
  schedulePersist();
  render();
  notify('Personaggio eliminato');
}

function toggleParticipantFavorite(combatId, participantId) {
  const combat = state.combats.find(c => c.id === combatId);
  if (!combat) return;
  const p = combat.participants.find(x => x.id === participantId);
  if (!p) return;
  snapshot();
  p.favorite = !p.favorite;
  syncFavoritesFromCombatParticipant(p);
  combat.updatedAt = nowIso();
  schedulePersist();
  render();
  notify(p.favorite ? 'Aggiunto ai preferiti' : 'Rimosso dai preferiti');
}

function applyHpDelta(combatId, participantId, delta, options = {}) {
  const combat = state.combats.find(c => c.id === combatId);
  if (!combat) return;
  const p = combat.participants.find(x => x.id === participantId);
  if (!p) return;
  snapshot();
  p.hp = clampNum((Number(p.hp) || 0) + delta, 0, Number(p.maxHp) || Math.max(0, (Number(p.hp) || 0) + delta));
  if (p.maxHp < p.hp) p.maxHp = p.hp;
  combat.updatedAt = nowIso();
  schedulePersist();
  if (!options.skipRender) render();
}

function nextTurn(combat) {
  if (!combat.participants.length) return;
  snapshot();
  combat.turnIndex = (combat.turnIndex + 1) % combat.participants.length;
  if (combat.turnIndex === 0) combat.round = (combat.round || 1) + 1;
  combat.updatedAt = nowIso();
  schedulePersist();
  render();
}

function numValue(sel) {
  const v = Number($(sel).value);
  return Number.isFinite(v) ? v : 0;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function exportAll() {
  const data = {
    version: VERSION,
    exportedAt: nowIso(),
    ...deepClone({
      combats: state.combats,
      favorites: state.favorites,
    }),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `belial-trial-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  notify('Backup esportato');
}

function importAllFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || '{}'));
      if (!confirm('Importare questo backup? Sostituirà i dati attuali.')) return;
      snapshot();
      state.combats = Array.isArray(data.combats) ? data.combats.map(normalizeCombat) : [];
      state.favorites = Array.isArray(data.favorites) ? data.favorites.map(normalizeParticipant) : [];
      state.activeCombatId = state.combats[0]?.id || null;
      state.view = state.combats.length ? 'home' : 'home';
      schedulePersist();
      render();
      notify('Backup importato');
    } catch (err) {
      console.error(err);
      notify('File non valido');
    }
  };
  reader.readAsText(file);
}

function startLongPress(ev, participantId) {
  cancelLongPress();
  const target = ev.currentTarget;
  longPressTimer = setTimeout(() => openParticipantModal(participantId), 520);
  const clear = () => cancelLongPress();
  target.addEventListener('pointerup', clear, { once: true });
  target.addEventListener('pointerleave', clear, { once: true });
  target.addEventListener('pointercancel', clear, { once: true });
}

function cancelLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#039;',
  }[m]));
}

document.addEventListener('click', (ev) => {
  const actionBtn = ev.target.closest('[data-action]');
  if (!actionBtn) return;

  const action = actionBtn.dataset.action;
  if (action === 'close-modal') closeModal();
  if (action === 'save-participant') saveParticipantFromModal();
  if (action === 'delete-participant') {
    const combat = currentCombatForEditor();
    const p = combat.participants.find(x => x.id === activeModalParticipantId);
    if (p) deleteParticipant(combat.id, p.id);
    closeModal();
  }
  if (action === 'hp-adjust') {
    const combat = currentCombatForEditor();
    const p = combat.participants.find(x => x.id === activeModalParticipantId);
    if (p) {
      applyHpDelta(combat.id, p.id, Number(actionBtn.dataset.delta || 0), { skipRender: true });
      const updated = combat.participants.find(x => x.id === activeModalParticipantId);
      if (updated) {
        $('#editHp').value = updated.hp;
        $('#editMaxHp').value = updated.maxHp;
        $('#editTitle').textContent = updated.name;
      }
      schedulePersist();
    }
  }
  if (action === 'back-home') {
    state.view = 'home';
    schedulePersist();
    render();
  }
  if (action === 'new-combat') {
    const combat = addCombat({ name: `Combattimento ${state.combats.length + 1}` });
    state.activeCombatId = combat.id;
    state.view = 'editor';
    schedulePersist();
    render();
  }
  if (action === 'export-all') exportAll();
  if (action === 'import-all') importFile.click();
  if (action === 'undo') undo();
});

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
  }
  if (ev.key === 'Escape') {
    if (!$('#modalHost').classList.contains('hidden')) closeModal();
  }
});

importFile.addEventListener('change', (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (file) importAllFromFile(file);
  importFile.value = '';
});

window.addEventListener('beforeunload', () => {
  updateCombatFromInputs(getActiveCombat() || {});
  persist();
});

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/belial-trial/service-worker.js');
    } catch (err) {
      console.warn('SW registration failed', err);
    }
  }
}

function init() {
  ensureStateShape();
  if (!state.combats.length) {
    const combat = normalizeCombat({
      name: 'Nuovo combattimento',
      participants: [],
      started: false,
      round: 1,
      turnIndex: 0,
    });
    state.combats.push(combat);
    state.activeCombatId = combat.id;
    state.view = 'home';
    persist();
  }
  render();
  registerSW();
  notify('Belial Trial pronto');
}

init();
