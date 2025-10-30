const socket = io();

// -------- UI Elements --------
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const enterRoomBtn = document.getElementById('enterRoomBtn');
const personalValue = document.getElementById('personalValue');
const personalUnit = document.getElementById('personalUnit');
const editorPanel = document.getElementById('editorPanel');
const editor = document.getElementById('editor');
const startBtn = document.getElementById('startBtn');
const countdown = document.getElementById('countdown');
const myProgress = document.getElementById('myProgress');
const participants = document.getElementById('participants');
const durationInput = document.getElementById('durationInput');
const durationInputRoom = document.getElementById('durationInputRoom');
const sprintSetupRoom = document.getElementById('sprintSetupRoom');
const shareLink = document.getElementById('shareLink');
const snapshotsPanel = document.getElementById('snapshotsPanel');
const snapshotsDiv = document.getElementById('snapshots');
const othersList = document.getElementById('othersList');
const autosaveIndicator = document.getElementById('autosaveIndicator');
const countdownLabel = document.getElementById('countdownLabel');

// -------- State --------
let currentRoom = null;
let isHost = false;
let displayName = '';
let personalGoalVal = 0;
let personalGoalUnit = 'words';
let hostConfig = { durationSeconds: 300 };
let sprintState = 'idle'; // idle | running | ending | ended
let sprintEndAt = null;
let countdownTimer = null;
let progressTimer = null;
let autosaveTimer = null;
let composing = false;

// -------- URL Params --------
const params = new URLSearchParams(window.location.search);
if (params.has('room')) {
    const roomId = params.get('room');
    roomInput.value = roomId;
    createBtn.classList.add('hidden');
    currentRoom = roomId;

    if (params.get('host') === '1') {
        isHost = true;
        document.getElementById('hostControls').classList.remove('hidden');
        shareLink.value = `${location.origin}/?room=${encodeURIComponent(currentRoom)}`;
    }
}

let editorControls = document.getElementById('editorControls')
let sprintControls = document.getElementById('sprintControls')
editorControls.classList.add('hidden');
sprintControls.classList.add('hidden');
countdownLabel.classList.add('hidden');

// -------- Room Join/Create --------
createBtn.addEventListener('click', () => location.href = '/create');

enterRoomBtn.addEventListener('click', () => {
    const roomId = (roomInput.value || '').trim();
    if (!roomId) return alert('Enter a room id or create one');

    displayName = (nameInput.value || 'Anonymous').trim();
    personalGoalVal = Number(personalValue.value) || 0;
    personalGoalUnit = personalUnit.value || 'words';

    if (isHost) {
        const durationSeconds = (Number(durationInput.value) || 5) * 60;
        hostConfig.durationSeconds = durationSeconds;
        console.log(durationSeconds)
        socket.emit('configureRoom', { roomId: currentRoom, durationSeconds });
    }

    socket.emit('joinRoom', {
        roomId,
        name: displayName,
        isHost,
        personalGoalValue: personalGoalVal,
        personalGoalUnit
    });

    currentRoom = roomId;
    document.getElementById('roomPanel').classList.add('hidden');
    editorPanel.style.display = 'block';

    if (isHost) {
        document.getElementById('hostControls').classList.remove('hidden');
        shareLink.value = `${location.origin}/?room=${encodeURIComponent(currentRoom)}`;
        editorControls.classList.remove('hidden');
        sprintControls.classList.remove('hidden');
        setHostConfig();
    } else {
        document.getElementById('hostControls').classList.add('hidden');
        startBtn.classList.add('hidden');
        durationInputRoom.classList.add('hidden');
        sprintSetupRoom.classList.add('hidden');

    }
    countdownLabel.classList.remove('hidden')
    // Load local draft if present
    const backup = localStorage.getItem(localDraftKey());
    if (backup) editor.textContent = backup;

    socket.emit('requestUserList', { roomId: currentRoom });
    socket.emit('updateRoomDuration', { roomId: currentRoom, durationSeconds: hostConfig.durationSeconds });


    displayCountdown(hostConfig.durationSeconds);

    sendProgressDebounced();

    durationInputRoom.value = durationInput.value
});

// -------- Sprint Start --------
startBtn.addEventListener('click', () => {
    if (!currentRoom || !isHost || sprintState !== 'idle') return;
    socket.emit('startSprint', { roomId: currentRoom });
    sprintState = 'running';
    updateStartButton();
});

// -------- Duration Input --------
durationInputRoom.addEventListener('input', () => {
    if (!currentRoom || sprintState === 'running') return;
    const durationSeconds = (Number(durationInputRoom.value) || 5) * 60;
    hostConfig.durationSeconds = durationSeconds;
    displayCountdown(durationSeconds);
    socket.emit('updateRoomDuration', { roomId: currentRoom, durationSeconds });
});

function setHostConfig() {
    const durationSeconds = (Number(durationInput.value) || 5) * 60;
    hostConfig.durationSeconds = durationSeconds;
    displayCountdown(durationSeconds);
    socket.emit('configureRoom', { roomId: currentRoom, durationSeconds });
}

// -------- Editor / Typing Logic --------
function localDraftKey() {
    return `draft_${currentRoom || 'no_room'}_${displayName || 'anon'}`;
}

function countWords(text) {
    return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function getEditorText() {
    return editor.innerText.replace(/\u00A0/g, ' ').trim();
}

editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => { composing = false; sendProgressDebounced(); });

editor.addEventListener('input', () => {
    const text = getEditorText();
    const wc = countWords(text);
    const percent = personalGoalVal ? Math.min(100, Math.round((wc / personalGoalVal) * 100)) : 0;
    myProgress.textContent = personalGoalUnit === 'percent' ? `${percent}%` : `Words: ${wc}`;
    sendProgressDebounced();
    scheduleAutosave();
});

editor.addEventListener('drop', e => e.preventDefault());
editor.addEventListener('dragover', e => e.preventDefault());
editor.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    insertTextAtCursor(text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
});

function insertTextAtCursor(text) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = document.createDocumentFragment();
    text.split(/\r\n|\r|\n/).forEach((line, i, arr) => {
        frag.appendChild(document.createTextNode(line));
        if (i < arr.length - 1) frag.appendChild(document.createElement('br'));
    });
    range.insertNode(frag);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function scheduleAutosave() {
    //if (sprintState === 'ended' || sprintState === 'ending') return;
    autosaveIndicator.className = 'autosave pending';
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
        localStorage.setItem(localDraftKey(), getEditorText());
        autosaveIndicator.className = 'autosave saved';
        setTimeout(() => autosaveIndicator.className = 'autosave idle', 800);
    }, 600);
}

window.addEventListener('beforeunload', () => {
    try { localStorage.setItem(localDraftKey(), getEditorText()); } catch (e) { }
});

// -------- Progress / Socket --------
function sendProgressDebounced() {
    if (composing) return;
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(sendProgressNow, 420);
}

function sendProgressNow() {
    if (!currentRoom) return;
    const text = getEditorText();
    const wc = countWords(text);
    socket.emit('progress', {
        roomId: currentRoom,
        text,
        wordCount: wc,
        personalGoalValue: personalGoalVal,
        personalGoalUnit
    });
}

// -------- Final Progress (includes disconnected users) --------
function sendFinalProgress() {
    if (!currentRoom || sprintState !== 'running') return;

    sprintState = 'ending';
    updateStartButton();

    const text = getEditorText();
    const wc = countWords(text);

    // Gather disconnected users
    const disconnectedSnapshots = [];
    Object.keys(localStorage).forEach(key => {
        if (!key.startsWith('draft_')) return;
        const [, roomId, userName] = key.split('_');
        if (roomId === currentRoom && userName !== (displayName || 'anon')) {
            const draftText = localStorage.getItem(key) || '';
            disconnectedSnapshots.push({
                name: userName,
                text: draftText,
                finalWordCount: countWords(draftText),
                socketId: null,
                displayUnit: 'words'
            });
        }
    });

    socket.emit('finalProgress', {
        roomId: currentRoom,
        text,
        wordCount: wc,
        personalGoalValue: personalGoalVal,
        personalGoalUnit,
        disconnectedSnapshots
    });
}

// -------- Participants / UI --------
function updateParticipants(users) {
    participants.innerHTML = '';
    othersList.innerHTML = '';
    users.forEach(u => {
        const displayText = (u.displayUnit === 'percent' && !u.isSelf)
            ? `${u.name} — ${u.percentOfPersonal}%`
            : `${u.name} — ${u.lastWordCount} words — ${u.percentOfPersonal}%`;
        const li = document.createElement('li');
        li.textContent = displayText + (u.isHost ? ' [host]' : '');
        participants.appendChild(li);

        const mini = document.createElement('div');
        mini.className = 'mini';
        mini.textContent = displayText;
        othersList.appendChild(mini);
    });
}

// -------- Countdown / Sprint Logic --------
function startLocalCountdown(endAt) {
    sprintState = 'running';
    sprintEndAt = endAt;
    durationInputRoom.disabled = true;
    snapshotsPanel.style.display = 'none';
    snapshotsDiv.innerHTML = '';

    function tick() {
        const rem = Math.max(0, Math.floor((sprintEndAt - Date.now()) / 1000));
        displayCountdown(rem);
        if (rem <= 0 && countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            if (sprintState === 'running') sendFinalProgress();
        }
    }

    tick();
    countdownTimer = setInterval(tick, 1000);
}

function displayCountdown(sec) {
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    countdown.textContent = `${mm}:${ss}`;
}

function updateStartButton() {
    startBtn.disabled = sprintState === 'running' || sprintState === 'ending';
    durationInputRoom.disabled = sprintState === 'running' || sprintState === 'ending';
}


function sprintEndCleanup() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    displayCountdown(0);
}

// -------- Snapshots UI --------
function showSnapshots(snapshots) {
    snapshotsPanel.style.display = 'block';
    snapshotsDiv.innerHTML = '';

    snapshots.forEach(s => {
        const wrap = document.createElement('div');
        wrap.className = 'snapshot';
        const isSelf = s.socketId === socket.id;
        const showWords = isSelf || s.displayUnit !== 'percent';

        const title = document.createElement('h4');
        title.textContent = showWords ? `${s.name} — ${s.finalWordCount} words` : `${s.name} — ${s.percentOfPersonal || 0}%`;

        const pre = document.createElement('pre');
        pre.textContent = showWords ? s.text : '';

        const dl = document.createElement('button');
        dl.textContent = 'Download';
        dl.addEventListener('click', () => downloadText(s.name, s.text));

        wrap.appendChild(title);
        wrap.appendChild(pre);
        wrap.appendChild(dl);
        snapshotsDiv.appendChild(wrap);
    });
}

// -------- Utilities --------
function downloadText(name, text) {
    const filename = `${sanitizeFileName(name || 'user')}-sprint.txt`;
    const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function sanitizeFileName(n) {
    return (n || 'user').replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
}

// -------- Socket Handlers --------
socket.on('roomState', payload => {
    if (!payload) return;
    hostConfig = payload.config || hostConfig;
    durationInput.value = hostConfig.durationSeconds;
    durationInputRoom.value = Math.floor(hostConfig.durationSeconds / 60);

    if (sprintState !== 'running') displayCountdown(hostConfig.durationSeconds);
    updateParticipants(payload.users || []);
    if (payload.timer?.endAt) startLocalCountdown(payload.timer.endAt);
});

socket.on('durationUpdated', ({ durationSeconds }) => {
    if (sprintState !== 'running') displayCountdown(durationSeconds);
});

socket.on('roomConfigured', cfg => { hostConfig = cfg; durationInput.value = hostConfig.durationSeconds; });
socket.on('userList', users => updateParticipants(users || []));
socket.on('progressUpdate', users => updateParticipants(users || []));
socket.on('sprintStarted', ({ endAt }) => startLocalCountdown(endAt));
socket.on('sprintEnded', ({ snapshots }) => {
    sprintState = 'ended';
    updateStartButton();
    showSnapshots(snapshots);
});
socket.on('tick', ({ remainingMs }) => displayCountdown(Math.max(0, Math.floor(remainingMs / 1000))));
socket.on('roomNotFound', () => alert('Room not found'));
socket.on('hostLeft', () => { /* handle host leaving */ });
socket.on('requestFinalProgress', () => sendFinalProgress());
