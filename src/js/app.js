/*
  src/js/app.js

  Optimistic-send revamp:
  - optimistic messages get data-temp-id and data-temp-ts
  - when server message arrives, attempt to find and upgrade the optimistic node
  - ensure cache + DOM avoid duplicates
*/

(async function() {
	// Base path for all API and socket calls — set by index.html before this script loads
	const BASE = window.__BASE || '';

	// All fetch calls use credentials:'include' so the httpOnly cookie
	// is sent automatically — no token handling in JS at all.
	const f = (url, opts = {}) => fetch(BASE + url, {
		credentials: 'include',
		headers: { 'Content-Type': 'application/json', ...opts.headers },
		...opts
	}).then(r => r.json());

	const API = {
		register: (u, p) => f('/api/register', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }),
		login:    (u, p) => f('/api/login',    { method: 'POST', body: JSON.stringify({ username: u, password: p }) }),
		logout:   ()     => f('/api/logout',   { method: 'POST' }),
		me:       ()     => f('/api/me'),
		users:    ()     => f('/api/users'),
		getChats: ()     => f('/api/chats'),
		createDirect:         (withUser)           => f('/api/chats/direct',      { method: 'POST', body: JSON.stringify({ withUser }) }),
		getMessages:          (chatId, limit = 200, before = 0) => f(`/api/chats/${chatId}/messages?limit=${limit}&before=${before}`),
		postMessage:          (chatId, text)       => f(`/api/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
		sendContactRequest:   (to)                 => f('/api/contacts/request',  { method: 'POST', body: JSON.stringify({ to }) }),
		respondContactRequest:(requestId, action)  => f('/api/contacts/respond',  { method: 'POST', body: JSON.stringify({ requestId, action }) }),
		getContactRequests:   ()                   => f('/api/contacts/requests'),
	};

	// State
	let currentUser = null;
	let socket = null;
	let chats = [];
	let currentChat = null;
	let messagesCache = {}; // chatId => [messages]

	// Elements
	const authModal = document.getElementById('authModal');
	const authForm = document.getElementById('authForm');
	const authTitle = document.getElementById('authTitle');
	const toggleAuthModeBtn = document.getElementById('toggleAuthMode');
	const authError = document.getElementById('authError');

	const usernameInput = document.getElementById('authUsername');
	const passwordInput = document.getElementById('authPassword');

	const chatListEl = document.getElementById('chatList');
	const inboxListEl = document.getElementById('inboxList');
	const contactListEl = document.getElementById('contactList');
	const currentChatTitle = document.getElementById('currentChatTitle');
	const messagesEl = document.getElementById('messages');
	const messageForm = document.getElementById('messageForm');
	const messageInput = document.getElementById('messageInput');
	const userStatus = document.getElementById('userStatus');

	const toggleSidebarBtn = document.getElementById('toggleSidebar');
	const sidebar = document.getElementById('sidebar');

	const logoutBtn = document.getElementById('logoutBtn');

	const contactUsernameInput = document.getElementById('contactUsername');
	const sendRequestBtn = document.getElementById('sendRequestBtn');
	const requestStatus = document.getElementById('requestStatus');

	const meNameEl = document.getElementById('meName');
	const meContactEl = document.getElementById('meContact');
	const meAvatarEl = document.getElementById('meAvatar');
	const copyContactBtn = document.getElementById('copyContactBtn');
	const searchChatsEl    = document.getElementById('searchChats');
	const searchInboxEl    = document.getElementById('searchInbox');
	const searchContactsEl    = document.getElementById('searchContacts');
	const searchContactsBtn   = document.getElementById('searchContactsBtn');
	const searchResultsEl     = document.getElementById('searchResults');
	let cachedUsers = []; // store for contact search
	let pendingRequests = []; // contact requests others sent to me, and ones I sent

	// Helpers
	function safeAddListener(el, ev, fn) {
		if (el) el.addEventListener(ev, fn);
	}

	function normalize(s) {
		return String(s || '').trim().toLowerCase();
	}

	function isMessageMine(msg) {
		if (!currentUser || !msg) return false;
		if (msg.sender && normalize(msg.sender) === normalize(currentUser.username)) return true;
		if (msg.senderId && currentUser.id && normalize(msg.senderId) === normalize(currentUser.id)) return true;
		if (msg.meta && msg.meta.from && normalize(msg.meta.from) === normalize(currentUser.username)) return true;
		return false;
	}

	function domHasMessageId(id) {
		if (!messagesEl || !id) return false;
		return !!messagesEl.querySelector(`[data-msg-id="${id}"]`);
	}

	function findOptimisticMatch(serverMessage) {
		if (!messagesEl || !serverMessage) return null;
		const candidates = Array.from(messagesEl.querySelectorAll('.msg.me')).filter(el => !el.getAttribute('data-msg-id'));
		for (let i = candidates.length - 1; i >= 0; i--) {
			const el = candidates[i];
			const txt = el.querySelector('.text') ? el.querySelector('.text').textContent : '';
			const tempTs = el.dataset.tempTs ? parseInt(el.dataset.tempTs, 10) : null;
			if (txt && txt.trim() === (serverMessage.text || '').trim()) {
				if (!tempTs) return el;
				if (Math.abs((serverMessage.timestamp || 0) - tempTs) <= 7000) return el;
			}
		}
		return null;
	}

	function upgradeOptimisticElement(el, serverMsg) {
		if (!el || !serverMsg) return;
		el.setAttribute('data-msg-id', serverMsg.id);
		el.removeAttribute('data-temp-id');
		if (el.dataset.tempTs) delete el.dataset.tempTs;
		const meta = el.querySelector('.meta');
		if (meta) meta.textContent = `${serverMsg.sender} • ${new Date(serverMsg.timestamp).toLocaleTimeString()}`;
		const text = el.querySelector('.text');
		if (text) text.textContent = serverMsg.text || '';
	}

	function appendMessage(msg, isLocal = false) {
		if (!messagesEl || !msg) return;
		if (msg.id && domHasMessageId(msg.id)) return;

		const el = document.createElement('div');
		el.className = 'msg' + (isMessageMine(msg) ? ' me' : '');
		if (isLocal) {
			const tempId = msg.id || ('temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
			el.setAttribute('data-temp-id', tempId);
			el.dataset.tempTs = msg.timestamp || Date.now();
		} else if (msg.id) {
			el.setAttribute('data-msg-id', msg.id);
		}

		const meta = document.createElement('div');
		meta.className = 'meta';
		meta.textContent = `${msg.sender} • ${new Date(msg.timestamp).toLocaleTimeString()}`;

		const text = document.createElement('div');
		text.className = 'text';
		text.textContent = msg.text || '';

		el.appendChild(meta);
		el.appendChild(text);

		if (msg.meta && msg.meta.type === 'contact_request' && msg.meta.requestId) {
			const actions = document.createElement('div');
			actions.className = 'actions';
			if (currentUser && msg.meta.from && normalize(msg.meta.from) !== normalize(currentUser.username)) {
				const acceptBtn = document.createElement('button');
				acceptBtn.className = 'btn primary';
				acceptBtn.textContent = 'Accept';
				const declineBtn = document.createElement('button');
				declineBtn.className = 'btn ghost';
				declineBtn.textContent = 'Decline';
				let done = false;
				acceptBtn.addEventListener('click', async () => {
					if (done) return;
					done = true;
					acceptBtn.disabled = declineBtn.disabled = true;
					acceptBtn.textContent = 'Accepting...';
					try {
						const res = await API.respondContactRequest(msg.meta.requestId, 'accept');
						if (res.error) {
							const note = document.createElement('div');
							note.className = 'small muted';
							note.textContent = res.error || 'Error';
							actions.appendChild(note);
						} else {
							acceptBtn.textContent = 'Accepted';
							declineBtn.style.display = 'none';
							await refreshChats();
						}
					} catch (err) { console.error(err); }
				});
				declineBtn.addEventListener('click', async () => {
					if (done) return;
					done = true;
					acceptBtn.disabled = declineBtn.disabled = true;
					declineBtn.textContent = 'Declining...';
					try {
						const res = await API.respondContactRequest(msg.meta.requestId, 'decline');
						if (res.error) {
							const note = document.createElement('div');
							note.className = 'small muted';
							note.textContent = res.error || 'Error';
							actions.appendChild(note);
						} else {
							declineBtn.textContent = 'Declined';
							acceptBtn.style.display = 'none';
							await refreshChats();
						}
					} catch (err) { console.error(err); }
				});
				actions.appendChild(acceptBtn);
				actions.appendChild(declineBtn);
				el.appendChild(actions);
			}
		}

		messagesEl.appendChild(el);
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function handleServerMessage(chatId, message) {
		if (!message) return;
		messagesCache[chatId] = messagesCache[chatId] || [];
		if (!messagesCache[chatId].some(m => m.id === message.id)) {
			messagesCache[chatId].push(message);
		}
		if (currentChat && currentChat.id === chatId && messagesEl) {
			if (domHasMessageId(message.id)) return;
			const match = findOptimisticMatch(message);
			if (match) {
				upgradeOptimisticElement(match, message);
				refreshChats().catch(() => {});
				return;
			}
			appendMessage(message, false);
			refreshChats().catch(() => {});
		} else {
			refreshChats().catch(() => {});
		}
	}

	// Tab switching
	document.querySelectorAll('.tab').forEach(btn => {
		safeAddListener(btn, 'click', () => {
			document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
			btn.classList.add('active');
			const tab = btn.getAttribute('data-tab');
			document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
			const panel = document.getElementById('panel-' + tab);
			if (panel) panel.classList.add('active');
			// Auto-load all users when contacts tab is opened
			if (tab === 'contacts') runContactSearch(true);
		});
	});

	// Search listeners
	if (searchChatsEl) {
		searchChatsEl.addEventListener('input', () => renderChats(searchChatsEl.value));
	}
	if (searchInboxEl) {
		searchInboxEl.addEventListener('input', () => renderInbox(searchInboxEl.value));
	}
	// Contacts search — fetch all users, show results with Send Request button
	async function runContactSearch(forceAll = false) {
		if (!searchResultsEl) return;
		const q = normalize(searchContactsEl ? searchContactsEl.value : '');
		searchResultsEl.innerHTML = '';

		// Fetch fresh list every time
		try {
			const [rawUsers, rawReqs] = await Promise.all([
				API.users(),
				API.getContactRequests().catch(() => [])
			]);
			cachedUsers = Array.isArray(rawUsers) ? rawUsers : (rawUsers && Array.isArray(rawUsers.users) ? rawUsers.users : []);
			pendingRequests = Array.isArray(rawReqs) ? rawReqs : [];
		} catch(e) { console.error(e); return; }

		const currentName = currentUser ? normalize(currentUser.username) : '';
		const results = cachedUsers.filter(u => {
			if (!u || !u.username) return false;
			if (normalize(u.username) === currentName) return false;
			if (!q || forceAll) return true; // show all if no query
			return normalize(u.username).includes(q) || normalize(u.contactNumber || '').includes(q);
		});

		if (!results.length) {
			const empty = document.createElement('div');
			empty.className = 'muted small';
			empty.style.padding = '8px 4px';
			empty.textContent = 'No users found.';
			searchResultsEl.appendChild(empty);
			return;
		}

		results.forEach(u => {
			// Use div not li — li CSS hover/transform swallows button clicks
			const row = document.createElement('div');
			row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:var(--panel);border:1px solid var(--border);margin-bottom:6px;';

			const left = document.createElement('div');
			left.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;';

			const avatar = document.createElement('div');
			avatar.className = 'avatar small';
			avatar.textContent = (u.username || '').slice(0, 2).toUpperCase();

			const info = document.createElement('div');
			info.className = 'meta';
			const name = document.createElement('div');
			name.className = 'bold';
			name.textContent = u.username;
			const num = document.createElement('div');
			num.className = 'small muted';
			num.textContent = u.contactNumber || '';
			info.appendChild(name);
			info.appendChild(num);

			left.appendChild(avatar);
			left.appendChild(info);

			const btn = document.createElement('button');
			btn.className = 'btn primary';
			btn.style.cssText = 'font-size:.8rem;padding:6px 12px;flex-shrink:0;';
			btn.textContent = 'Add';
			btn.type = 'button';
			btn.onclick = async (e) => {
				e.stopPropagation();
				btn.disabled = true;
				btn.textContent = '...';
				try {
					const res = await API.sendContactRequest(u.username);
					if (res.error) {
						btn.textContent = res.error.includes('pending') ? 'Sent' : 'Error';
					} else {
						btn.textContent = '✓ Sent';
						row.style.borderColor = 'var(--red)';
						if (requestStatus) { requestStatus.textContent = `Request sent to ${u.username}`; setTimeout(() => { requestStatus.textContent = ''; }, 3000); }
					}
				} catch(e) {
					console.error('sendContactRequest failed', e);
					btn.textContent = 'Error';
					btn.disabled = false;
				}
			};

			// Check if they sent us a pending request
			const theyRequestedMe = pendingRequests.find(r => normalize(r.from) === normalize(u.username) && r.status === 'pending');
			const iSentThem = pendingRequests.find(r => normalize(r.to) === normalize(u.username) && r.status === 'pending');
			const alreadyContacts = chats.some(c => c.type === 'direct' && c.participants.includes(u.username));

			if (alreadyContacts) {
				btn.textContent = '✓ Contact';
				btn.disabled = true;
				btn.className = 'btn ghost';
			} else if (theyRequestedMe) {
				// They sent us a request — show accept button instead
				const badge = document.createElement('span');
				badge.style.cssText = 'font-size:.75rem;color:var(--red);font-family:var(--mono);margin-right:6px;white-space:nowrap;';
				badge.textContent = 'sent you a request';
				btn.textContent = 'Accept';
				btn.onclick = async (e) => {
					e.stopPropagation();
					btn.disabled = true; btn.textContent = '...';
					try {
						const res = await API.respondContactRequest(theyRequestedMe.id, 'accept');
						if (res.error) { btn.textContent = 'Error'; }
						else { btn.textContent = '✓ Accepted'; badge.textContent = ''; await refreshChats(); }
					} catch(e) { btn.textContent = 'Error'; btn.disabled = false; }
				};
				row.appendChild(left);
				row.appendChild(badge);
				row.appendChild(btn);
				searchResultsEl.appendChild(row);
				return;
			} else if (iSentThem) {
				btn.textContent = 'Sent';
				btn.disabled = true;
				btn.className = 'btn ghost';
			}

			row.appendChild(left);
			row.appendChild(btn);
			searchResultsEl.appendChild(row);
		});
	}

	if (searchContactsBtn) {
		searchContactsBtn.addEventListener('click', runContactSearch);
	}
	if (searchContactsEl) {
		searchContactsEl.addEventListener('keydown', e => { if (e.key === 'Enter') runContactSearch(); });
	}

	// Sidebar toggle
	if (toggleSidebarBtn && sidebar) {
		toggleSidebarBtn.addEventListener('click', () => {
			sidebar.classList.toggle('collapsed');
			toggleSidebarBtn.textContent = sidebar.classList.contains('collapsed') ? '☰' : '≡';
		});
	}

	// Auth mode toggle
	let mode = 'login';
	safeAddListener(toggleAuthModeBtn, 'click', () => {
		mode = mode === 'login' ? 'register' : 'login';
		if (authTitle) authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create account';
		const submit = document.getElementById('authSubmit');
		if (submit) submit.textContent = mode === 'login' ? 'Sign in' : 'Create';
		if (authError) authError.textContent = '';
	});

	// Auth submit
	if (authForm) {
		authForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			if (authError) authError.textContent = '';
			const u = (usernameInput && usernameInput.value || '').trim();
			const p = (passwordInput && passwordInput.value || '').trim();
			if (!u || !p) {
				if (authError) authError.textContent = 'Please fill fields';
				return;
			}
			try {
				const res = mode === 'login' ? await API.login(u, p) : await API.register(u, p);
				if (res.error) {
					if (authError) authError.textContent = res.error;
					return;
				}
				messagesCache = {};
				currentChat = null;
				await boot();
				if (authModal) authModal.style.display = 'none';
				if (mode === 'register' && res.user && res.user.contactNumber) {
					alert(`Welcome ${res.user.username}!\nYour contact number: ${res.user.contactNumber}`);
				}
			} catch (err) {
				console.error(err);
				if (authError) authError.textContent = 'Network error';
			}
		});
	}

	// Logout
	if (logoutBtn) {
		logoutBtn.addEventListener('click', async () => {
			try { await API.logout(); } catch(e) {}
			currentUser = null;
			messagesCache = {};
			chats = [];
			cachedUsers = [];
			pendingRequests = [];
			currentChat = null;
			if (chatListEl) chatListEl.innerHTML = '';
			if (contactListEl) contactListEl.innerHTML = '';
			if (inboxListEl) inboxListEl.innerHTML = '';
			if (messagesEl) messagesEl.innerHTML = '<div class="placeholder">Select a chat to start messaging.</div>';
			if (messageForm) messageForm.style.display = 'none';
			if (authModal) authModal.style.display = 'flex';
			if (socket) {
				try { socket.disconnect(); } catch (e) {}
				socket = null;
			}
		});
	}

	// Message send
	if (messageForm) {
		messageForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			const text = (messageInput && messageInput.value || '').trim();
			if (!text || !currentChat || !currentUser) return;

			const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
			const tempTs = Date.now();
			const tempMsg = { id: tempId, sender: currentUser.username, text, timestamp: tempTs };
			messagesCache[currentChat.id] = messagesCache[currentChat.id] || [];
			messagesCache[currentChat.id].push(tempMsg);
			appendMessage(tempMsg, true);
			messageInput.value = '';

			if (socket && socket.connected) {
				socket.emit('send_message', { chatId: currentChat.id, text });
				return;
			}
			try {
				const res = await API.postMessage(currentChat.id, text);
				if (res && res.id) handleServerMessage(currentChat.id, res);
			} catch (err) {
				console.error('postMessage error', err);
			}
		});
	}

	// Send contact request
	if (sendRequestBtn && contactUsernameInput) {
		sendRequestBtn.addEventListener('click', async () => {
			const to = (contactUsernameInput.value || '').trim();
			if (!to) {
				if (requestStatus) requestStatus.textContent = 'Enter a username';
				return;
			}
			if (currentUser && (normalize(to) === normalize(currentUser.username) || normalize(to) === normalize(currentUser.contactNumber))) {
				if (requestStatus) requestStatus.textContent = "You can't request yourself.";
				return;
			}
			sendRequestBtn.disabled = true;
			sendRequestBtn.textContent = 'Sending...';
			try {
				const res = await API.sendContactRequest(to);
				if (res.error) {
					if (requestStatus) requestStatus.textContent = res.error;
				} else {
					if (requestStatus) requestStatus.textContent = 'Request sent!';
					contactUsernameInput.value = '';
					await refreshChats();
				}
			} catch (err) {
				console.error(err);
				if (requestStatus) requestStatus.textContent = 'Network error';
			} finally {
				sendRequestBtn.disabled = false;
				sendRequestBtn.textContent = 'Send Request';
				setTimeout(() => { if (requestStatus) requestStatus.textContent = ''; }, 3000);
			}
		});
	}

	// Copy contact
	if (copyContactBtn) {
		copyContactBtn.addEventListener('click', async () => {
			if (!currentUser || !currentUser.contactNumber) return;
			try {
				await navigator.clipboard.writeText(currentUser.contactNumber);
				copyContactBtn.textContent = 'Copied!';
				setTimeout(() => { copyContactBtn.textContent = 'Copy my contact'; }, 1500);
			} catch (err) { console.error(err); }
		});
	}

	// Render lists
	function renderChats(query = '') {
		if (!chatListEl) return;
		chatListEl.innerHTML = '';
		const q = normalize(query);
		chats.filter(c => c.type === 'direct').filter(c => {
			if (!q) return true;
			const other = (c.participants || []).find(p => normalize(p) !== normalize(currentUser && currentUser.username)) || '';
			const lastTxt = c.lastMessage ? normalize(c.lastMessage.text || '') : '';
			return normalize(other).includes(q) || lastTxt.includes(q);
		}).forEach(c => {
			const li = document.createElement('li');
			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			const other = (c.participants || []).find(p => normalize(p) !== normalize(currentUser && currentUser.username)) || c.participants[0];
			avatar.textContent = (other || '?').slice(0, 2).toUpperCase();
			const meta = document.createElement('div');
			meta.className = 'meta';
			const title = document.createElement('div');
			title.textContent = other || 'Chat';
			const sub = document.createElement('div');
			sub.className = 'small muted';
			sub.textContent = c.lastMessage ? `${c.lastMessage.sender}: ${String(c.lastMessage.text || '').slice(0, 40)}` : 'No messages';
			meta.appendChild(title);
			meta.appendChild(sub);
			li.appendChild(avatar);
			li.appendChild(meta);
			li.addEventListener('click', () => openChat(c));
			chatListEl.appendChild(li);
		});
	}

	function renderInbox(query = '') {
		if (!inboxListEl) return;
		inboxListEl.innerHTML = '';
		const q = normalize(query);
		chats.filter(c => c.type === 'inbox').filter(c => {
			if (!q) return true;
			const lastTxt = c.lastMessage ? normalize(c.lastMessage.text || '') : '';
			return lastTxt.includes(q);
		}).forEach(c => {
			const li = document.createElement('li');
			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			avatar.textContent = 'I';
			const meta = document.createElement('div');
			meta.className = 'meta';
			const title = document.createElement('div');
			title.textContent = 'Inbox';
			const sub = document.createElement('div');
			sub.className = 'small muted';
			sub.textContent = c.lastMessage ? String(c.lastMessage.text || '').slice(0, 60) : 'No notifications';
			meta.appendChild(title);
			meta.appendChild(sub);
			li.appendChild(avatar);
			li.appendChild(meta);
			li.addEventListener('click', () => openChat(c));
			inboxListEl.appendChild(li);
		});
	}

	async function renderContacts(query = '') {
		if (!contactListEl) return;
		contactListEl.innerHTML = '';
		try {
			// Only fetch from API if cache is empty
			if (!cachedUsers.length) {
				const raw = await API.users();
				cachedUsers = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.users) ? raw.users : []);
			}
			const users = cachedUsers;
			const q = normalize(query);
			const currentName = currentUser && currentUser.username ? normalize(currentUser.username) : null;
			const contactSet = new Set();
			if (currentName) contactSet.add(normalize(currentName));
			if (Array.isArray(chats)) {
				for (const c of chats) {
					if (!c || !Array.isArray(c.participants)) continue;
					const partIds = c.participants.map(p => {
						if (!p && p !== 0) return '';
						if (typeof p === 'string') return normalize(p);
						if (typeof p === 'object') return normalize(p.username || p.id || '');
						return '';
					}).filter(Boolean);
					if (currentName && partIds.includes(normalize(currentName))) {
						for (const id of partIds) contactSet.add(id);
					}
				}
			}
			const visible = users.filter(u => {
				if (!u || !u.username) return false;
				if (!contactSet.has(normalize(u.username))) return false;
				if (!q) return true;
				return normalize(u.username).includes(q) || normalize(u.contactNumber || '').includes(q);
			});
			visible.filter(u => normalize(u.username) !== normalize(currentName)).forEach(u => {
				const li = document.createElement('li');
				const avatar = document.createElement('div');
				avatar.className = 'avatar';
				avatar.textContent = (u.username || '').slice(0, 2).toUpperCase();
				const meta = document.createElement('div');
				meta.className = 'meta';
				const title = document.createElement('div');
				title.textContent = u.username;
				const sub = document.createElement('div');
				sub.className = 'small muted';
				sub.textContent = u.contactNumber ? `Contact: ${u.contactNumber}` : '';
				meta.appendChild(title);
				meta.appendChild(sub);
				li.appendChild(avatar);
				li.appendChild(meta);
				li.addEventListener('click', async () => {
					try {
						const chat = await API.createDirect(u.username);
						await refreshChats();
						const c = chats.find(x => x.id === chat.id);
						if (c) openChat(c);
					} catch (err) { console.error('Could not create/open chat', err); }
				});
				contactListEl.appendChild(li);
			});
			if (!visible || visible.length <= 1) {
				const hint = document.createElement('div');
				hint.className = 'muted small';
				hint.style.padding = '10px';
				hint.textContent = 'No other users found. Invite friends to try real-time chat!';
				contactListEl.appendChild(hint);
			}
		} catch (err) {
			console.error('Failed to load contacts', err);
			const errEl = document.createElement('div');
			errEl.className = 'muted small';
			errEl.textContent = 'Error loading contacts';
			contactListEl.appendChild(errEl);
		}
	}

	async function openChat(chat) {
		if (!chat) return;
		currentChat = chat;
		if (currentChatTitle) currentChatTitle.textContent = (chat.type === 'inbox') ? 'Inbox' : (chat.participants.find(p => normalize(p) !== normalize(currentUser.username)) || 'Chat');
		if (messageForm) messageForm.style.display = chat.type === 'direct' ? 'flex' : 'none';
		clearMessages();
		try {
			const msgs = await API.getMessages(chat.id, 200);
			msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
			messagesCache[chat.id] = msgs.slice();
			if (!msgs.length) {
				if (messagesEl) messagesEl.innerHTML = '<div class="placeholder muted">No messages yet — say hi 👋</div>';
			} else {
				msgs.forEach(m => appendMessage(m));
			}
		} catch (err) {
			console.error('Failed to load messages', err);
			if (messagesEl) messagesEl.innerHTML = '<div class="placeholder muted">Could not load messages</div>';
		}
	}

	function clearMessages() {
		if (!messagesEl) return;
		messagesEl.innerHTML = '';
		messagesEl.classList.remove('empty');
	}

	async function refreshChats() {
		if (!currentUser) return;
		try {
			chats = await API.getChats();
			renderChats();
			renderInbox();
			// Ensure socket is subscribed to all rooms, including newly created ones
			if (socket && socket.connected) chats.forEach(c => socket.emit('join_chat', { chatId: c.id }));
		} catch (err) {
			console.error('Failed to refresh chats', err);
		}
	}

	async function boot() {
		try {
			const me = await API.me();
			if (me && me.username) {
				currentUser = me;
				if (userStatus) userStatus.textContent = currentUser.username;
				if (meNameEl) meNameEl.textContent = currentUser.username;
				if (meAvatarEl) meAvatarEl.textContent = currentUser.username.slice(0, 2).toUpperCase();
				if (meContactEl && currentUser.contactNumber) meContactEl.textContent = 'Contact: ' + currentUser.contactNumber;

				if (window.io) {
					try {
						if (socket) { socket.disconnect(); socket = null; }
						socket = io({
							path: BASE + '/socket.io',
							withCredentials: true
						});
						socket.on('connect', () => {
							// Re-join all known rooms on every (re)connect
							chats.forEach(c => socket.emit('join_chat', { chatId: c.id }));
						});
						socket.on('new_message', ({ chatId, message }) => {
							handleServerMessage(chatId, message);
						});
						socket.on('chat_created', () => { refreshChats(); });
						socket.on('typing', () => { /* optional typing UI */ });
					} catch (e) {
						console.error('socket error', e);
						socket = null;
					}
				}

				await refreshChats();
				// Join any chat rooms we now know about
				if (socket && socket.connected) chats.forEach(c => socket.emit('join_chat', { chatId: c.id }));
				await renderContacts();
				if (authModal) authModal.style.display = 'none';
			} else {
								token = null;
				if (authModal) authModal.style.display = 'flex';
			}
		} catch (err) {
			console.error('Boot error', err);
			if (authModal) authModal.style.display = 'flex';
		}
	}

	// Try to restore session from cookie
	await boot();

})();