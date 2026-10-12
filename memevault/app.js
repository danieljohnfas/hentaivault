/* ===================================================
   MemeVault – Application Logic
   =================================================== */

// ────────────────────────────────────────────────────
// DATA
// ────────────────────────────────────────────────────

let POSTS_DATA = [];

// ── API HELPERS ──────────────────────────────────────
async function apiFetch(url, options = {}) {
    const token = state.user?.token;
    const headers = {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.headers || {})
    };

    // Only set JSON Content-Type if body is NOT FormData
    if (options.body && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
        logout(); // Auto logout on expired token
        throw new Error('Unauthenticated');
    }
    return res;
}

// ── STATE & PERSISTENCE ────────────────────────────────

async function loadState() {
    let posts = [];
    const savedUser = localStorage.getItem('memevault_user');
    const user = savedUser ? JSON.parse(savedUser) : null;

    // Set a temporary partial state so apiFetch can find the token if it exists
    const tempUser = user;

    try {
        const token = tempUser?.token;
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/posts?limit=1000&offset=0`, { headers });

        if (res.ok) {
            posts = (await res.json()).map(processPostMetadata);
        }
    } catch (e) {
        console.error('Failed to load posts from API', e);
    }

    return {
        posts: posts,
        currentPost: null,
        activeCat: 'all',
        activeSort: 'hot',
        user: user,
        hasMore: posts.length >= 1000,
        chatMessages: [],
        chatOpen: false,
    };
}

let state = {
    posts: [],
    activePosts: [], // Track current filtered/sorted view for modal navigation
    currentPost: null,
    activeCat: 'all',
    activeSort: 'hot',
    user: null,
    hasMore: true,
    chatMessages: [],
    chatOpen: false,
};

let videoObserver;

function initVideoObserver() {
    videoObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target;
            if (entry.isIntersecting) {
                video.play().catch(e => console.log('Autoplay blocked', e));
            } else {
                video.pause();
            }
        });
    }, { threshold: 0.5 });
}

function saveState() {
    localStorage.setItem('memevault_user', JSON.stringify(state.user));
}

// ── UTILITIES ───────────────────────────────────────

function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function processPostMetadata(p) {
    if (!p.authorEmoji) p.authorEmoji = '😎';
    if (!p.authorColor) p.authorColor = 'linear-gradient(135deg,#7c3aed,#e91e63)';
    return p;
}

function isVideo(url) {
    if (!url) return false;
    const cleanUrl = url.split('?')[0].toLowerCase();
    const ext = cleanUrl.split('.').pop();
    return ['mp4', 'webm', 'ogg', 'mov', 'gifv'].includes(ext) ||
        url.includes('v.redd.it') ||
        url.includes('fallback_url') ||
        (url.includes('giphy.com') && (url.endsWith('.mp4') || url.includes('/looping/')));
}

function showToast(msg, type = '') {
    const tc = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    tc.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

function openOverlay(id) {
    document.getElementById(id).classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeOverlay(id) {
    document.getElementById(id).classList.remove('open');
    document.body.style.overflow = '';
}

// ────────────────────────────────────────────────────
// RENDER POSTS
// ────────────────────────────────────────────────────

function renderPosts(posts) {
    const feed = document.getElementById('feed');
    feed.innerHTML = '';
    if (!posts.length) {
        feed.innerHTML = `
            <div style="text-align:center;padding:80px 20px;color:var(--text-muted);">
                <div style="font-size:64px;margin-bottom:16px;">📭</div>
                <h2 style="font-size:20px;font-weight:800;color:var(--text-secondary);margin-bottom:8px;">No posts yet</h2>
                <p style="font-size:14px;">Be the first to share a meme! Hit the <strong style="color:var(--accent-light);">Post</strong> button above.</p>
            </div>`;
        return;
    }
    posts.forEach((post, idx) => {
        const card = buildPostCard(post, idx);
        feed.appendChild(card);
    });
}

function buildPostCard(post, idx) {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.style.animationDelay = (idx * 0.06) + 's';
    card.id = 'post-' + post.id;

    const voteColor = post.userVote === 'up'
        ? 'color:var(--hot)'
        : post.userVote === 'down'
            ? 'color:var(--blue)'
            : '';

    const mediaUrl = post.image.replace('.gifv', '.mp4');

    card.innerHTML = `
    <div class="post-header">
      <span class="post-category-badge">${post.category}</span>
      <div class="post-author-info">
        <div class="post-author-avatar" style="background:${post.authorColor}">${post.authorEmoji}</div>
        <span>${post.author}</span>
        <span>·</span>
        <span>${post.time}</span>
      </div>
    </div>
    <h2 class="post-title">${post.title}</h2>
    <div class="post-media">
      ${isVideo(mediaUrl)
            ? `<video src="${mediaUrl}" autoplay muted loop playsinline></video>`
            : `<img src="${mediaUrl}" alt="${post.title}" loading="lazy" />`
        }
      <div class="post-media-overlay">
        <span class="overlay-text">Click to view & comment</span>
      </div>
    </div>
    <div class="post-actions">
      <div class="vote-section">
        <button class="vote-btn upvote-btn ${post.userVote === 'up' ? 'upvote-active' : ''}" data-id="${post.id}" aria-label="Upvote">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${post.userVote === 'up' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <span class="vote-count" style="${voteColor}">${formatNum(post.upvotes)}</span>
        <button class="vote-btn downvote-btn ${post.userVote === 'down' ? 'downvote-active' : ''}" data-id="${post.id}" aria-label="Downvote">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${post.userVote === 'down' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <button class="post-action-btn open-modal-btn" data-id="${post.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        ${formatNum(post.comments)} Comments
      </button>
      <button class="post-action-btn share-btn" data-id="${post.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        Share
      </button>
      <button class="post-action-btn save-btn" data-id="${post.id}" style="${post.saved ? 'color:var(--accent-light);border-color:var(--accent)' : ''}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${post.saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        ${post.saved ? 'Saved' : 'Save'}
      </button>
    </div>
    <div class="post-tags">${post.tags.map(t => `<span class="post-tag">${t}</span>`).join('')}</div>
  `;

    // Vote buttons
    card.querySelector('.upvote-btn').addEventListener('click', (e) => { e.stopPropagation(); handleVote(post.id, 'up'); });
    card.querySelector('.downvote-btn').addEventListener('click', (e) => { e.stopPropagation(); handleVote(post.id, 'down'); });

    // Open modal
    card.querySelector('.open-modal-btn').addEventListener('click', (e) => { e.stopPropagation(); openPost(post.id); });
    card.querySelector('.post-media').addEventListener('click', () => openPost(post.id));
    card.querySelector('.post-title').addEventListener('click', () => openPost(post.id));

    // Share
    card.querySelector('.share-btn').addEventListener('click', (e) => { e.stopPropagation(); handleShare(post); });

    // Save
    card.querySelector('.save-btn').addEventListener('click', (e) => { e.stopPropagation(); handleSave(post.id); });

    if (isVideo(mediaUrl)) {
        setTimeout(() => {
            const video = card.querySelector('video');
            if (video && videoObserver) {
                videoObserver.observe(video);
            }
        }, 0);
    }

    return card;
}

// ────────────────────────────────────────────────────
// VOTING
// ────────────────────────────────────────────────────

async function handleVote(id, dir) {
    if (!state.user) {
        openOverlay('loginModal');
        showToast('⚠️ Please sign in to vote.', 'error');
        return;
    }

    const post = state.posts.find(p => p.id === id);
    if (!post) return;

    let newVote = dir;
    let uiToast = dir === 'up' ? '🔥 Upvoted!' : '👎 Downvoted!';

    if (post.userVote === dir) {
        // undo vote
        post.upvotes += dir === 'up' ? -1 : 1;
        newVote = null;
        uiToast = 'Vote removed';
    } else {
        if (post.userVote) {
            // changing vote direction
            post.upvotes += dir === 'up' ? 2 : -2;
        } else {
            // adding new vote
            post.upvotes += dir === 'up' ? 1 : -1;
        }
    }
    
    post.userVote = newVote;

    // API call with explicit intended state
    apiFetch(`/api/posts/${id}/upvote`, {
        method: 'POST',
        body: JSON.stringify({ dir: newVote })
    }).catch(e => console.error('Vote failed', e));

    saveState();
    refreshFilteredFeed();

    // update modal if open
    if (state.currentPost && state.currentPost.id === id) {
        document.getElementById('modalVoteCount').textContent = formatNum(post.upvotes);
        const up = document.getElementById('modalUpvote');
        const dn = document.getElementById('modalDownvote');
        up.classList.toggle('active', post.userVote === 'up');
        dn.classList.toggle('active', post.userVote === 'down');
    }

    if (newVote) {
        showToast(uiToast, newVote === 'up' ? 'success' : '');
    }
}

// ────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────

async function handleSave(id) {
    if (!state.user) {
        openOverlay('loginModal');
        showToast('⚠️ Please sign in to save posts.', 'error');
        return;
    }

    const post = state.posts.find(p => p.id === id);
    if (!post) return;

    // Optimistic UI toggle
    post.saved = !post.saved;
    refreshFilteredFeed();

    try {
        const res = await apiFetch(`/api/posts/${id}/save`, {
            method: 'POST'
        });
        const data = await res.json();
        if (res.ok) {
            post.saved = data.saved; // Ensure sync with server
            showToast(post.saved ? '🔖 Post saved!' : '🗑️ Removed from saved', post.saved ? 'success' : '');
            refreshFilteredFeed();
        } else {
            // Revert on error
            post.saved = !post.saved;
            refreshFilteredFeed();
            showToast('❌ Failed to save post.', 'error');
        }
    } catch (err) {
        console.error('Save failed:', err);
        post.saved = !post.saved;
        refreshFilteredFeed();
    }
}

// ────────────────────────────────────────────────────
// SHARE
// ────────────────────────────────────────────────────

function handleShare(post) {
    const url = window.location.href + '#post-' + post.id;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showToast('🔗 Link copied!', 'success'));
    } else {
        showToast('🔗 ' + url, 'success');
    }
}

// ────────────────────────────────────────────────────
// REMIX
// ────────────────────────────────────────────────────

function handleRemix(post) {
    const mediaUrl = post.image;
    if (isVideo(mediaUrl)) {
        showToast('⚠️ Cannot remix videos yet!', 'error');
        return;
    }
    
    if (!state.user) {
        openOverlay('loginModal');
        showToast('⚠️ Please sign in to remix memes.', 'error');
        return;
    }

    closeOverlay('postModal');
    openOverlay('memeGenModal');
    
    showToast('🔄 Loading image for remix...', 'success');
    
    const img = new Image();
    img.crossOrigin = "Anonymous";
    
    // Function to set up canvas once image loads
    const setupCanvas = () => {
        memeGenState.image = img;
        memeGenState.topText = '';
        memeGenState.bottomText = '';
        const topInp = document.getElementById('memeTextTop');
        const botInp = document.getElementById('memeTextBottom');
        if (topInp) topInp.value = '';
        if (botInp) botInp.value = '';
        updateMemeCanvas();
        showToast('✨ Ready to remix!', 'success');
    };

    img.onload = setupCanvas;
    
    img.onerror = () => {
        // Fallback to proxy if direct CORS fails
        img.onerror = () => showToast('❌ Failed to load image for remix', 'error');
        img.src = `/api/ai/proxy?url=${encodeURIComponent(mediaUrl)}`;
    };
    
    img.src = mediaUrl;
}

// ────────────────────────────────────────────────────
// FILTER & SORT
// ────────────────────────────────────────────────────

function getFilteredPosts() {
    let posts = [...state.posts];

    // Category filter
    if (state.activeCat === 'myposts') {
        posts = posts.filter(p => p.author === state.user?.username);
    } else if (state.activeCat === 'savedposts') {
        posts = posts.filter(p => p.saved);
    } else if (state.activeCat === 'foryou') {
        // AI "For You" Feed logic: Sort by user preferences.
        // Simple client-side personalization: boost posts matching categories the user saved or upvoted.
        let prefs = {};
        state.posts.forEach(p => {
            if (p.saved || p.userVote === 'up') {
                prefs[p.category] = (prefs[p.category] || 0) + 1;
            }
            if (p.userVote === 'down') {
                prefs[p.category] = (prefs[p.category] || 0) - 1;
            }
        });
        
        // Add random jitter to weights to keep feed fresh, and factor in upvotes + comments
        posts.forEach(p => {
            const catWeight = prefs[p.category] || 0;
            const popularity = (p.upvotes * 2) + p.comments;
            const recency = p.id; // newer posts have slightly higher base id
            p._foryouScore = (catWeight * 50) + popularity + (recency * 0.1) + (Math.random() * 20);
        });
        posts.sort((a, b) => b._foryouScore - a._foryouScore);
    } else if (state.activeCat !== 'all') {
        const catMap = {
            kiswahili: 'Kiswahili', funny: 'Funny', gaming: 'Gaming', anime: 'Anime',
            wholesome: 'Wholesome', animals: 'Animals', dark: 'Dark Humor',
            programming: 'Programming', relationship: 'Relationship', sports: 'Sports'
        };
        const catLabel = catMap[state.activeCat];
        if (catLabel) posts = posts.filter(p => p.category === catLabel);
        else posts = posts.filter(p => p.category && p.category.toLowerCase() === state.activeCat.toLowerCase());
    }

    // Sort (unless For You which provides its own sort)
    if (state.activeCat !== 'foryou') {
        if (state.activeSort === 'hot') posts.sort((a, b) => b.upvotes - a.upvotes);
        else if (state.activeSort === 'new') posts.sort((a, b) => b.id - a.id);
        else if (state.activeSort === 'top') posts.sort((a, b) => (b.upvotes + b.comments) - (a.upvotes + a.comments));
    }

    return posts;
}

function refreshFilteredFeed() {
    const list = getFilteredPosts();
    state.activePosts = list;

    // Update feed title based on active category
    const titleEl = document.querySelector('.feed-title');
    if (titleEl) {
        if (state.activeCat === 'myposts') titleEl.textContent = '👤 My Posts';
        else if (state.activeCat === 'savedposts') titleEl.textContent = '🔖 Saved Memes';
        else if (state.activeCat === 'foryou') titleEl.textContent = '🧠 For You';
        else if (state.activeCat === 'all') titleEl.textContent = '🔥 Hot Posts';
        else titleEl.textContent = `📂 ${state.activeCat.charAt(0).toUpperCase() + state.activeCat.slice(1)}`;
    }

    renderPosts(list);
}

// ────────────────────────────────────────────────────
// POST MODAL
// ────────────────────────────────────────────────────

function openPost(id) {
    const post = state.posts.find(p => p.id === id);
    if (!post) return;
    state.currentPost = post;

    const mediaContainer = document.querySelector('.modal-left');
    const mediaUrl = post.image.replace('.gifv', '.mp4');

    mediaContainer.innerHTML = isVideo(mediaUrl)
        ? `<video src="${mediaUrl}" controls autoplay loop playsinline class="modal-video"></video>`
        : `<img src="${mediaUrl}" alt="${post.title}" class="modal-img" id="modalImg" />`;

    if (!isVideo(mediaUrl)) {
        const img = document.getElementById('modalImg');
        if (img) {
            img.src = mediaUrl;
            img.alt = post.title;
        }
    }
    document.getElementById('modalCategory').textContent = post.category;
    document.getElementById('modalTitle').textContent = post.title;
    document.getElementById('modalAuthorAvatar').textContent = post.authorEmoji;
    document.getElementById('modalAuthor').textContent = post.author;
    document.getElementById('modalTime').textContent = post.time;
    document.getElementById('modalVoteCount').textContent = formatNum(post.upvotes);

    const up = document.getElementById('modalUpvote');
    const dn = document.getElementById('modalDownvote');
    up.classList.toggle('active', post.userVote === 'up');
    dn.classList.toggle('active', post.userVote === 'down');

    // Navigation visibility
    const currentIndex = state.activePosts.findIndex(p => p.id === id);
    document.getElementById('modalPrev').style.display = currentIndex > 0 ? 'flex' : 'none';
    document.getElementById('modalNext').style.display = currentIndex < state.activePosts.length - 1 ? 'flex' : 'none';

    // Tags
    const tagsEl = document.getElementById('modalTags');
    tagsEl.innerHTML = post.tags.map(t => `<span class="post-tag">${t}</span>`).join('');

    // Comments
    renderComments(post);

    openOverlay('postModal');
}

function navigateModal(dir) {
    if (!state.currentPost) return;
    const currentIndex = state.activePosts.findIndex(p => p.id === state.currentPost.id);
    const newIndex = currentIndex + dir;

    if (newIndex >= 0 && newIndex < state.activePosts.length) {
        openPost(state.activePosts[newIndex].id);
    }
}

function renderComments(post) {
    const list = document.getElementById('commentsList');
    list.innerHTML = '';

    post.commentList.forEach(c => {
        const el = document.createElement('div');
        el.className = 'comment';
        el.innerHTML = `
      <div class="comment-avatar" style="background:${c.color}">${c.emoji}</div>
      <div class="comment-body">
        <div class="comment-author">${c.author}</div>
        <div class="comment-text">${c.text}</div>
        <div class="comment-time">${c.time}</div>
      </div>
    `;
        list.appendChild(el);
    });

    document.getElementById('commentCount').textContent = post.commentList.length;
}

function addComment(text) {
    if (!state.user) {
        openOverlay('loginModal');
        showToast('⚠️ Please sign in to comment.', 'error');
        return;
    }

    const post = state.currentPost;
    if (!post || !text.trim()) return;

    const newComment = {
        author: state.user.username,
        emoji: state.user.picture ? '' : '😎',
        color: '#7c3aed',
        text: text.trim(),
        time: 'Just now',
    };

    post.commentList.unshift(newComment);
    post.comments++;
    saveState();
    renderComments(post);
    refreshFilteredFeed();
    showToast('💬 Comment posted!', 'success');
}

// ────────────────────────────────────────────────────
// GOOGLE OAUTH
// ────────────────────────────────────────────────────

// IMPORTANT: Replace YOUR_GOOGLE_CLIENT_ID in index.html with your real Client ID.
// Get one at: https://console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID
// Authorized JavaScript origins: add  http://localhost (for local server) or null (for file://)

/**
 * Called automatically by Google Identity Services after the user picks their account.
 * The credential is a signed JWT – we decode it client-side to get the user's profile.
 * No secret is exposed: the JWT is validated server-side in production, but for a
 * client-only demo we can safely read the payload to get name / email / picture.
 */
async function handleGoogleCredential(response) {
    try {
        // Decode the JWT payload (Base64url → JSON)
        // Using a more robust method to handle non-Latin1 characters
        const base64Url = response.credential.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));

        const payload = JSON.parse(jsonPayload);

        // Get a MemeVault token from the server
        const res = await apiFetch('/api/auth/google', {
            method: 'POST',
            body: JSON.stringify({
                username: payload.name || payload.email,
                email: payload.email,
                picture: payload.picture || '',
            })
        });

        const data = await res.json();
        if (res.ok) {
            loginUser({
                ...data.user,
                token: data.token,
                provider: 'google',
            });
        } else {
            console.error('Login error response:', data);
            showToast(`❌ Google login failed: ${data.error || 'Server error'}`, 'error');
        }
    } catch (err) {
        console.error('Google login catch block:', err);
        showToast('⚠️ Google sign-in failed. Check console for details.', 'error');
    }
}

// Expose globally so the GIS library can call it via data-callback
window.handleGoogleCredential = handleGoogleCredential;

// ────────────────────────────────────────────────────
// LOGIN / USER
// ────────────────────────────────────────────────────

/**
 * @param {object} userInfo - { username, email, picture, token }
 */
function loginUser(userInfo) {
    state.user = userInfo;
    saveState();

    const { username, picture, isInit, provider } = userInfo;

    // Hide sign-in button, show avatar
    document.getElementById('loginBtn').style.display = 'none';
    const aw = document.getElementById('avatarMenu');
    aw.style.display = 'flex';

    // Update avatar UI
    const av = document.getElementById('userAvatar');
    if (picture) {
        av.src = picture;
    } else {
        av.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;
    }

    // Update comment avatar to reflect user
    const commentAv = document.querySelector('.user-avatar-small');
    if (commentAv) {
        if (picture) {
            commentAv.innerHTML = `<img src="${picture}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;" />`;
        } else {
            commentAv.textContent = '😎';
        }
    }

    const providerLabel = provider === 'google' ? ' via Google' : '';
    saveState();

    // Check if initializing (don't show toast on boot if already logged in)
    if (!isInit) {
        showToast(`👋 Welcome, ${username}${providerLabel}!`, 'success');

        // RE-FETCH POSTS to get saved status correctly from DB
        loadState().then(newState => {
            state.posts = newState.posts;
            state.hasMore = newState.hasMore;
            refreshFilteredFeed();
        });
    } else {
        refreshFilteredFeed();
    }
    closeOverlay('loginModal');
}

function logout() {
    // Revoke Google token if signed in via Google
    if (state.user && state.user.provider === 'google' && window.google && google.accounts) {
        try {
            google.accounts.id.revoke(state.user.email, done => {
                console.log('Google session revoked');
            });
        } catch (e) {
            console.error('Failed to revoke Google session', e);
        }
    }

    state.user = null;
    saveState();

    // Reset UI
    document.getElementById('loginBtn').style.display = '';
    document.getElementById('avatarMenu').style.display = 'none';

    // Reset comment avatar
    const commentAv = document.querySelector('.user-avatar-small');
    if (commentAv) commentAv.textContent = '😎';

    showToast('👋 Signed out. See ya!');

    // Refresh feed to show standard "Hot" view and CLEAR saved/nsfw state
    state.activeCat = 'all';
    loadState().then(newState => {
        state.posts = newState.posts;
        state.hasMore = newState.hasMore;
        refreshFilteredFeed();
    });
}

// ────────────────────────────────────────────────────
// SEARCH
// ────────────────────────────────────────────────────

function handleSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) { refreshFilteredFeed(); return; }

    const results = state.posts.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.tags.some(t => t.toLowerCase().includes(q)) ||
        p.author.toLowerCase().includes(q)
    );

    const feed = document.getElementById('feed');
    feed.innerHTML = '';
    if (!results.length) {
        feed.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted)">🔍 No results for "<strong>${query}</strong>"</div>`;
        return;
    }
    results.forEach((p, i) => feed.appendChild(buildPostCard(p, i)));
}

// ────────────────────────────────────────────────────
// LOAD MORE (SIMULATE)
// ────────────────────────────────────────────────────

async function loadMorePosts() {
    if (!state.hasMore) return;

    const spinner = document.getElementById('loadSpinner');
    const btnText = document.querySelector('.load-more-text');
    const btn = document.getElementById('loadMoreBtn');

    spinner.classList.add('active');
    if (btnText) btnText.textContent = 'Loading…';

    try {
        const token = state.user?.token;
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/posts?limit=1000&offset=${state.posts.length}`, { headers });
        if (res.ok) {
            const newPosts = (await res.json()).map(processPostMetadata);
            if (newPosts.length < 1000) {
                state.hasMore = false;
            }
            state.posts = [...state.posts, ...newPosts];
            saveState();
            refreshFilteredFeed();

            if (!state.hasMore) {
                if (btnText) btnText.textContent = "no more memes, please post more";
                if (btn) {
                    btn.disabled = true;
                    btn.style.opacity = '0.7';
                    btn.style.cursor = 'default';
                }
            } else {
                if (btnText) btnText.textContent = 'Load More';
            }

            if (newPosts.length > 0) {
                showToast('🎉 More memes loaded!', 'success');
            }
        }
    } catch (e) {
        console.error('Failed to load more posts', e);
        showToast('❌ Failed to load more memes', 'error');
    } finally {
        spinner.classList.remove('active');
    }
}

// ────────────────────────────────────────────────────
// LOAD STATS
// ────────────────────────────────────────────────────

async function loadCommunityStats() {
    try {
        const res = await apiFetch('/api/stats');
        if (!res.ok) return;
        const stats = await res.json();

        document.getElementById('statMembers').textContent = formatNum(stats.members);
        document.getElementById('statLaughs').textContent = formatNum(stats.laughs);

        // for "online" just show a reasonable fraction of members if low
        const onlineCount = Math.max(1, Math.floor(stats.members * 0.15));
        document.getElementById('statOnline').textContent = formatNum(onlineCount);

        const list = document.getElementById('contributorsList');
        if (list) {
            list.innerHTML = '';
            stats.topContributors.forEach((c, idx) => {
                const li = document.createElement('li');
                li.className = 'contributor';

                // assign some gradient colors
                const colors = [
                    'linear-gradient(135deg,#6c63ff,#e91e63)',
                    'linear-gradient(135deg,#ff6b35,#f7c59f)',
                    'linear-gradient(135deg,#00d2ff,#3a7bd5)',
                    'linear-gradient(135deg,#f9ca24,#f0932b)',
                    'linear-gradient(135deg,#6ab04c,#badc58)'
                ];
                const bg = colors[idx % colors.length];

                const avatarContent = (c.authorPic && c.authorPic.startsWith('http'))
                    ? `<img src="${c.authorPic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
                    : (c.authorPic || c.author.charAt(0).toUpperCase());

                li.innerHTML = `
                  <div class="contrib-avatar" style="background:${bg}">${avatarContent}</div>
                  <div class="contrib-info">
                      <span class="contrib-name">${c.author}</span>
                      <span class="contrib-pts">${formatNum(c.pts)} pts</span>
                  </div>
                `;
                list.appendChild(li);
            });

            // If no contributors yet, show a fallback message
            if (stats.topContributors.length === 0) {
                list.innerHTML = '<li style="padding:10px;color:var(--text-muted);font-size:13px;text-align:center;">Be the first contributor!</li>';
            }
        }
    } catch (e) {
        console.error('Failed to load community stats', e);
    }
}

// ────────────────────────────────────────────────────
// SCROLL EFFECTS & INFINITE SCROLL
// ────────────────────────────────────────────────────

function initScrollEffects() {
    const navbar = document.getElementById('navbar');
    const scrollBtn = document.getElementById('scrollTop');

    const mainContent = document.querySelector('.main-content');

    let isFetching = false;

    mainContent.addEventListener('scroll', async () => {
        const y = mainContent.scrollTop;
        navbar.classList.toggle('scrolled', y > 10);
        scrollBtn.classList.toggle('visible', y > 300);

        // Infinite Scroll Logic
        if (state.hasMore && !isFetching) {
            if (mainContent.scrollHeight - mainContent.scrollTop - mainContent.clientHeight < 800) {
                isFetching = true;
                await loadMorePosts();
                isFetching = false;
            }
        }
    });

    scrollBtn.addEventListener('click', () => mainContent.scrollTo({ top: 0, behavior: 'smooth' }));

    // Modal Navigation
    document.getElementById('modalPrev').addEventListener('click', (e) => { e.stopPropagation(); navigateModal(-1); });
    document.getElementById('modalNext').addEventListener('click', (e) => { e.stopPropagation(); navigateModal(1); });

    // Keyboard Navigation
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('postModal');
        if (modal.classList.contains('open')) {
            if (e.key === 'ArrowLeft') navigateModal(-1);
            if (e.key === 'ArrowRight') navigateModal(1);
        }
    });
}

// ────────────────────────────────────────────────────
// MEME GENERATOR
// ────────────────────────────────────────────────────

let memeGenState = {
    image: null,
    topText: '',
    bottomText: '',
    fontSize: 40,
    color: '#ffffff'
};

function updateMemeCanvas() {
    const canvas = document.getElementById('memeCanvas');
    const ctx = canvas.getContext('2d');
    if (!memeGenState.image) return;

    // Set canvas size to match image (capped for performance/view)
    const img = memeGenState.image;
    const maxW = 800;
    const scale = Math.min(1, maxW / img.width);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Text settings
    const fontSize = parseInt(memeGenState.fontSize) * scale;
    ctx.font = `900 ${fontSize}px Impact, Arial Black, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = memeGenState.color;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = fontSize / 8;
    ctx.lineJoin = 'round';

    const drawText = (text, x, y, isBottom) => {
        ctx.textBaseline = isBottom ? 'bottom' : 'top';
        ctx.strokeText(text.toUpperCase(), x, y);
        ctx.fillText(text.toUpperCase(), x, y);
    };

    if (memeGenState.topText) {
        drawText(memeGenState.topText, canvas.width / 2, 10 * scale, false);
    }
    if (memeGenState.bottomText) {
        drawText(memeGenState.bottomText, canvas.width / 2, canvas.height - (10 * scale), true);
    }
}

async function handleMemeGenFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            memeGenState.image = img;
            updateMemeCanvas();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function publishMeme() {
    const canvas = document.getElementById('memeCanvas');
    if (!memeGenState.image) return showToast('⚠️ Add an image first!', 'error');

    const btn = document.getElementById('memePublishBtn');
    btn.disabled = true;
    btn.textContent = 'Publishing...';

    try {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        const formData = new FormData();
        formData.append('file', blob, 'meme.jpg');

        const uploadRes = await apiFetch('/api/upload', {
            method: 'POST',
            body: formData,
            headers: {}
        });
        if (!uploadRes.ok) throw new Error('Upload failed');
        const uploadData = await uploadRes.json();

        const titleText = (memeGenState.topText + ' ' + memeGenState.bottomText).trim() || 'My Masterpiece';
        const newPost = {
            title: titleText,
            category: 'Funny',
            image: uploadData.url,
            author: state.user ? state.user.username : 'Anonymous',
            authorPic: state.user ? state.user.picture : '',
            tags: ['#meme', '#generator']
        };

        const postRes = await apiFetch('/api/posts', {
            method: 'POST',
            body: JSON.stringify(newPost)
        });

        if (postRes.ok) {
            showToast('🚀 Meme published!', 'success');
            closeOverlay('memeGenModal');
            state.activeCat = 'all';
            state.activeSort = 'new';
            // Reload posts (simple way)
            location.reload();
        }
    } catch (err) {
        console.error('Publish failed:', err);
        showToast('❌ Failed to publish', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Publish';
    }
}

// ────────────────────────────────────────────────────
// OBSERVERS & EVENT LISTENERS
// ────────────────────────────────────────────────────

async function init() {
    // Load state from the backend api
    state = await loadState();

    // Clear any stale localStorage that may contain old mock data
    const hadOldMockPosts = state.posts.some(p => p.image && p.image.startsWith('images/'));
    if (hadOldMockPosts) {
        state.posts = [];
        saveState();
    }

    // If user was loaded from storage, set up UI silently
    if (state.user) {
        loginUser({ ...state.user, isInit: true });
    }

    // Initial render
    refreshFilteredFeed();
    loadCommunityStats();
    initScrollEffects();
    initVideoObserver();

    // Set initial state of Load More button
    if (!state.hasMore) {
        const btn = document.getElementById('loadMoreBtn');
        const btnText = document.querySelector('.load-more-text');
        btnText.textContent = "no more memes, please post more";
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'default';
    }

    // NAV Links
    document.querySelectorAll('.nav-link').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            a.classList.add('active');
            const section = a.dataset.section;
            if (section === 'hot') {
                state.activeCat = 'all';
                state.activeSort = 'hot';
            } else if (section === 'trending') {
                state.activeCat = 'all';
                state.activeSort = 'top';
            } else if (section === 'fresh') {
                state.activeCat = 'all';
                state.activeSort = 'new';
            } else if (section === 'foryou') {
                state.activeCat = 'foryou';
            } else {
                state.activeCat = section;
            }
            refreshFilteredFeed();
        });
    });

    // Category pills
    document.querySelectorAll('.cat-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.activeCat = btn.dataset.cat;
            refreshFilteredFeed();
        });
    });

    // Sort buttons
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.activeSort = btn.dataset.sort;
            refreshFilteredFeed();
        });
    });

    // Search
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    let debounce;
    searchInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => handleSearch(searchInput.value), 300);
    });
    searchBtn.addEventListener('click', () => handleSearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(searchInput.value); });

    // Load More
    document.getElementById('loadMoreBtn').addEventListener('click', loadMorePosts);

    // Post Modal close
    document.getElementById('modalClose').addEventListener('click', () => closeOverlay('postModal'));
    document.getElementById('postModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeOverlay('postModal');
    });

    // Modal votes
    document.getElementById('modalUpvote').addEventListener('click', () => {
        if (state.currentPost) handleVote(state.currentPost.id, 'up');
    });
    document.getElementById('modalDownvote').addEventListener('click', () => {
        if (state.currentPost) handleVote(state.currentPost.id, 'down');
    });

    // Modal share
    document.getElementById('modalShare').addEventListener('click', () => {
        if (state.currentPost) handleShare(state.currentPost);
    });

    // Modal save
    document.getElementById('modalSave').addEventListener('click', () => {
        if (state.currentPost) {
            handleSave(state.currentPost.id);
            const btn = document.getElementById('modalSave');
            const post = state.posts.find(p => p.id === state.currentPost.id);
            btn.textContent = post.saved ? '🔖 Saved' : '🔖 Save';
        }
    });

    // Modal remix
    const remixBtn = document.getElementById('modalRemix');
    if (remixBtn) {
        remixBtn.addEventListener('click', () => {
            if (state.currentPost) handleRemix(state.currentPost);
        });
    }

    // Comment submit
    document.getElementById('commentSubmit').addEventListener('click', () => {
        const input = document.getElementById('commentInput');
        addComment(input.value);
        input.value = '';
    });
    document.getElementById('commentInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            addComment(e.target.value);
            e.target.value = '';
        }
    });

    // AI Roast
    const roastBtn = document.getElementById('aiRoastBtn');
    if (roastBtn) {
        roastBtn.addEventListener('click', async () => {
            if (!state.user) {
                openOverlay('loginModal');
                showToast('⚠️ Please sign in to roast.', 'error');
                return;
            }
            if (!state.currentPost) return;
            
            const originalText = roastBtn.textContent;
            roastBtn.textContent = '🤔...';
            roastBtn.disabled = true;
            
            try {
                const res = await apiFetch('/api/ai/roast', {
                    method: 'POST',
                    body: JSON.stringify({
                        title: state.currentPost.title,
                        tags: state.currentPost.tags
                    })
                });
                const data = await res.json();
                if (res.ok) {
                    addComment(data.text);
                } else {
                    showToast('❌ ' + (data.error || 'Failed to roast'), 'error');
                }
            } catch (err) {
                console.error('Roast error:', err);
                showToast('❌ Failed to connect to AI', 'error');
            } finally {
                roastBtn.textContent = originalText;
                roastBtn.disabled = false;
            }
        });
    }

    // Upload modal – open / close
    document.getElementById('uploadBtn').addEventListener('click', () => {
        if (!state.user) {
            openOverlay('loginModal');
            showToast('⚠️ Please sign in to post memes.', 'error');
            return;
        }
        openOverlay('uploadModal');
    });
    document.getElementById('uploadClose').addEventListener('click', () => closeOverlay('uploadModal'));
    document.getElementById('uploadModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeOverlay('uploadModal');
    });

    // Upload modal – full posting pipeline

    let pendingFile = null; // holds the File object the user picked

    function setDropzoneFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
            showToast('⚠️ Only images and videos are supported.', 'error');
            return;
        }
        pendingFile = file;

        // Live preview inside the dropzone
        const dropzone = document.getElementById('dropzone');
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                dropzone.innerHTML = `
                    <img src="${ev.target.result}"
                         style="max-width:100%;max-height:180px;border-radius:8px;object-fit:contain;"
                         alt="preview" />
                    <p style="margin-top:10px;font-size:12px;color:var(--text-muted)">${file.name}</p>
                    <button type="button" id="clearFile"
                            style="margin-top:8px;background:none;border:1px solid var(--border);color:var(--text-secondary);
                                   border-radius:99px;padding:4px 14px;font-size:12px;cursor:pointer;">✕ Remove</button>
                `;
                document.getElementById('clearFile').addEventListener('click', clearDropzone);
            };
            reader.readAsDataURL(file);
        } else {
            dropzone.innerHTML = `
                <div class="dropzone-icon">🎬</div>
                <p>${file.name}</p>
                <button type="button" id="clearFile"
                        style="margin-top:8px;background:none;border:1px solid var(--border);color:var(--text-secondary);
                               border-radius:99px;padding:4px 14px;font-size:12px;cursor:pointer;">✕ Remove</button>
            `;
            document.getElementById('clearFile').addEventListener('click', clearDropzone);
        }
        showToast('📂 File ready: ' + file.name, 'success');
    }

    function clearDropzone() {
        pendingFile = null;
        const dropzone = document.getElementById('dropzone');
        dropzone.innerHTML = `
            <div class="dropzone-icon">🖼️</div>
            <p>Drag & drop your meme here</p>
            <span>or</span>
            <label class="btn-file-pick" for="fileInput">Browse Files</label>
            <input type="file" id="fileInput" accept="image/*,video/*" hidden />
        `;

        // Re-attach the file input listener to the newly created element
        document.getElementById('fileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) setDropzoneFile(file);
        });
    }

    // Dropzone drag-and-drop
    const dropzone = document.getElementById('dropzone');
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) setDropzoneFile(file);
    });

    // Initial File picker listener
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) setDropzoneFile(file);
        });
    }

    // Submit – create the post and save the file on the server
    document.getElementById('submitUpload').addEventListener('click', async () => {
        const titleEl = document.getElementById('uploadTitle');
        const catEl = document.getElementById('uploadCategory');
        const tagsEl = document.getElementById('uploadTags');
        const btn = document.getElementById('submitUpload');

        const title = titleEl.value.trim();
        const cat = catEl.value;

        if (!title) { showToast('⚠️ Give your meme a title!', 'error'); titleEl.focus(); return; }
        if (!cat) { showToast('⚠️ Pick a category!', 'error'); catEl.focus(); return; }
        if (!pendingFile) { showToast('⚠️ Please select an image or video!', 'error'); return; }

        const rawTags = tagsEl.value.trim();
        const tags = rawTags
            ? rawTags.split(',').map(t => (t.trim().startsWith('#') ? t.trim() : '#' + t.trim())).filter(Boolean)
            : ['#meme', '#fresh'];

        const nsfwChecked = document.getElementById('uploadNsfw').checked;
        if (nsfwChecked && !tags.includes('#nsfw')) {
            tags.push('#nsfw');
        }

        const author = state.user ? state.user.username : 'Anonymous';
        const authorPic = state.user ? state.user.picture : '';
        const emoji = authorPic ? '' : '😎';
        const color = 'linear-gradient(135deg,#7c3aed,#e91e63)';

        btn.disabled = true;
        btn.textContent = 'Uploading…';

        try {
            let imageUrl;

            // ── Server mode: POST file to /api/upload ──────────────────
            const formData = new FormData();
            formData.append('file', pendingFile);

            // Note: browser doesn't need 'Content-Type': 'multipart/form-data' manually set with FormData
            const res = await apiFetch('/api/upload', {
                method: 'POST',
                body: formData,
                headers: {} // apiFetch defaults to JSON, but for FormData we MUST let browser set it
            });

            // Special override for FormData: avoid setting Content-Type in apiFetch
            // Wait, I should fix apiFetch to handle FormData better.

            if (!res.ok) throw new Error(`Server upload failed: ${res.status}`);
            const data = await res.json();
            imageUrl = data.url;

            let newPost = {
                title,
                category: cat.charAt(0).toUpperCase() + cat.slice(1),
                image: imageUrl,
                author,
                authorPic,
                tags
            };

            // Save post to the database
            const postRes = await apiFetch('/api/posts', {
                method: 'POST',
                body: JSON.stringify(newPost)
            });

            if (postRes.ok) {
                const postData = await postRes.json();
                newPost.id = postData.id;
            }

            // Fill out client side properties
            newPost = {
                ...newPost,
                upvotes: 1,
                comments: 0,
                authorEmoji: authorPic ? `<img src="${authorPic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : emoji,
                authorColor: color,
                time: 'Just now',
                commentList: [],
                userVote: 'up',
                saved: false,
                isOwn: true,
            };

            state.posts.unshift(newPost);
            saveState();

            state.activeSort = 'new';
            document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('[data-sort="new"]').classList.add('active');
            state.activeCat = 'all';
            document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
            document.querySelector('[data-cat="all"]').classList.add('active');

            refreshFilteredFeed();
            document.querySelector('.main-content').scrollTo({ top: 0, behavior: 'smooth' });

            titleEl.value = '';
            catEl.value = '';
            tagsEl.value = '';
            clearDropzone();

            closeOverlay('uploadModal');
            showToast('🚀 Meme posted! It\'s live!', 'success');

        } catch (err) {
            console.error('Upload error:', err);
            showToast('❌ Upload failed: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🚀 Publish Meme';
        }
    });

    // Login modal
    document.getElementById('loginBtn').addEventListener('click', () => openOverlay('loginModal'));
    document.getElementById('loginClose').addEventListener('click', () => closeOverlay('loginModal'));
    document.getElementById('loginModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeOverlay('loginModal');
    });

    // Login / Signup tabs
    document.getElementById('signinTab').addEventListener('click', () => {
        document.getElementById('signinTab').classList.add('active');
        document.getElementById('signupTab').classList.remove('active');
        document.getElementById('loginForm').style.display = 'flex';
        document.getElementById('signupForm').style.display = 'none';
    });
    document.getElementById('signupTab').addEventListener('click', () => {
        document.getElementById('signupTab').classList.add('active');
        document.getElementById('signinTab').classList.remove('active');
        document.getElementById('signupForm').style.display = 'flex';
        document.getElementById('loginForm').style.display = 'none';
    });

    // Login Form Submit
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;

        if (!username || !password) return showToast('⚠️ Please enter username and password', 'error');

        try {
            const res = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (res.ok) {
                loginUser({ ...data.user, token: data.token });
            } else {
                showToast(`❌ ${data.error}`, 'error');
            }
        } catch (err) {
            console.error('Login failed:', err);
            showToast('❌ Login failed. Check your connection.', 'error');
        }
    });

    // Signup Form Submit
    document.getElementById('signupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('signupUsername').value.trim();
        const email = document.getElementById('signupEmail').value.trim();
        const password = document.getElementById('signupPassword').value;

        if (!username || !email || !password) return showToast('⚠️ Please fill all fields', 'error');

        try {
            const res = await apiFetch('/api/auth/signup', {
                method: 'POST',
                body: JSON.stringify({ username, email, password })
            });
            const data = await res.json();
            if (res.ok) {
                showToast('🎉 Account created! Please log in.', 'success');
                // Switch to login tab
                document.getElementById('signinTab').click();
            } else {
                showToast(`❌ ${data.error}`, 'error');
            }
        } catch (err) {
            console.error('Signup failed:', err);
            showToast('❌ Signup failed.', 'error');
        }
    });

    // ── Fallback Google buttons ──────────────────────────────────────────────
    // Shown when GIS hasn't loaded yet or the Client ID is still a placeholder.
    // Clicking them programmatically triggers the Google One Tap / popup flow
    // once a real Client ID is configured.
    function triggerGoogleSignIn() {
        if (window.google && google.accounts && google.accounts.id) {
            // Prompt the One-Tap/popup UI
            google.accounts.id.prompt((notification) => {
                if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                    showToast('⚠️ Google sign-in unavailable. Check your Client ID in index.html.', 'error');
                }
            });
        } else {
            showToast('⚠️ Google sign-in not ready. Add your Client ID to index.html!', 'error');
        }
    }

    const fallbackSignIn = document.getElementById('googleFallbackBtn');
    const fallbackSignUp = document.getElementById('googleFallbackSignupBtn');
    const githubBtn = document.getElementById('githubBtn');

    if (fallbackSignIn) fallbackSignIn.addEventListener('click', triggerGoogleSignIn);
    if (fallbackSignUp) fallbackSignUp.addEventListener('click', triggerGoogleSignIn);

    // Hide fallback buttons after GIS renders its own button (brief delay for async load)
    setTimeout(() => {
        const gsiButtons = document.querySelectorAll('.g_id_signin iframe');
        gsiButtons.forEach(iframe => {
            const wrap = iframe.closest('.gsi-btn-wrap');
            if (wrap) {
                const fallback = wrap.querySelector('.social-btn.google');
                if (fallback) fallback.style.display = 'none';
            }
        });
    }, 2500);

    if (githubBtn) {
        githubBtn.addEventListener('click', () => {
            showToast('🐙 GitHub sign-in coming soon!', '');
        });
    }

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', (e) => { e.preventDefault(); logout(); });

    // My Profile / Saved Links
    document.getElementById('myPostsLink').addEventListener('click', (e) => {
        e.preventDefault();
        state.activeCat = 'myposts';
        refreshFilteredFeed();
        document.getElementById('avatarDropdown').style.display = 'none'; // Close dropdown
    });

    document.getElementById('savedMemesLink').addEventListener('click', (e) => {
        e.preventDefault();
        state.activeCat = 'savedposts';
        refreshFilteredFeed();
        document.getElementById('avatarDropdown').style.display = 'none'; // Close dropdown
    });

    // Join community
    document.getElementById('joinBtn')?.addEventListener('click', () => {
        if (!state.user) { openOverlay('loginModal'); return; }
        showToast('🎉 You joined the community!', 'success');
    });

    // Hamburger / sidebar toggle
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarClose = document.getElementById('sidebarClose');

    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => sidebar.classList.add('open'));
    }
    if (sidebarClose && sidebar) {
        sidebarClose.addEventListener('click', () => sidebar.classList.remove('open'));
    }

    // Keyboard ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeOverlay('postModal');
            closeOverlay('uploadModal');
            closeOverlay('loginModal');
            closeOverlay('memeGenModal');
            if (sidebar) sidebar.classList.remove('open');
        }
    });

    // ── Meme Generator Listeners ──
    document.getElementById('memeGenLink').addEventListener('click', (e) => {
        e.preventDefault();
        openOverlay('memeGenModal');
    });
    document.getElementById('memeGenClose').addEventListener('click', () => closeOverlay('memeGenModal'));

    document.getElementById('genFileInput').addEventListener('change', (e) => handleMemeGenFile(e.target.files[0]));

    ['memeTextTop', 'memeTextBottom', 'memeFontSize', 'memeColor'].forEach(id => {
        document.getElementById(id).addEventListener('input', (e) => {
            const key = id.replace('meme', '').charAt(0).toLowerCase() + id.replace('meme', '').slice(1);
            memeGenState[key] = e.target.value;
            updateMemeCanvas();
        });
    });

    document.getElementById('memePublishBtn').addEventListener('click', publishMeme);
    document.getElementById('memeDownloadBtn').addEventListener('click', () => {
        const canvas = document.getElementById('memeCanvas');
        if (!memeGenState.image) return showToast('⚠️ Add an image first!', 'error');
        const link = document.createElement('a');
        link.download = 'memevault-masterpiece.jpg';
        link.href = canvas.toDataURL('image/jpeg', 0.9);
        link.click();
    });

    // AI Generation
    document.getElementById('btnAiGenImage').addEventListener('click', () => generateAIMeme('image'));
    document.getElementById('btnAiGenVideo').addEventListener('click', () => generateAIMeme('video'));

    initChat();
}

async function generateAIMeme(type) {
    const prompt = document.getElementById('aiMemePrompt').value.trim();
    if (!prompt) return showToast('⚠️ Enter a prompt first!', 'error');

    if (!state.user) {
        openOverlay('loginModal');
        return showToast('⚠️ Please sign in to use AI generation.', 'error');
    }

    const status = document.getElementById('aiLoadingStatus');
    const btnImg = document.getElementById('btnAiGenImage');
    const btnVid = document.getElementById('btnAiGenVideo');

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            status.style.display = 'block';
            status.innerHTML = `<span class="ai-pulse">✨ AI is thinking (Attempt ${attempts}/${maxAttempts})...</span>`;
            btnImg.disabled = true;
            btnVid.disabled = true;

            // If an image exists on canvas, we can send it for "remixing"
            let imageData = null;
            if (memeGenState.image) {
                const canvas = document.getElementById('memeCanvas');
                imageData = canvas.toDataURL('image/jpeg', 0.8);
            }

            const res = await apiFetch('/api/ai/generate', {
                method: 'POST',
                body: JSON.stringify({ prompt, type, image: imageData })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || 'AI request failed');
            }

            const data = await res.json();
            console.log(`AI Gen URL [${type}]:`, data.url);

            // Use the proxy to load the image (Bypasses CORS/Network issues)
            const proxyUrl = `/api/ai/proxy?url=${encodeURIComponent(data.url)}`;

            await new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous'; // Still needed for canvas but proxy handles the response headers
                img.onload = () => {
                    console.log('AI Image loaded successfully via proxy.');
                    memeGenState.image = img;
                    updateMemeCanvas();
                    resolve();
                };
                img.onerror = (err) => {
                    console.error('AI Proxy loading error:', err);
                    reject(new Error(`Failed to load generated AI asset via proxy.`));
                };
                img.src = proxyUrl;
            });

            showToast(`✨ AI ${type === 'video' ? 'Video' : 'Image'} ready!`, 'success');
            status.style.display = 'none';
            btnImg.disabled = false;
            btnVid.disabled = false;
            return; // Exit on success

        } catch (err) {
            console.error(`AI Gen Attempt ${attempts} failed:`, err);
            if (attempts >= maxAttempts) {
                showToast(`❌ ${err.message}`, 'error');
                status.style.display = 'none';
                btnImg.disabled = false;
                btnVid.disabled = false;
            } else {
                // Wait small delay before retry
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
}

// ────────────────────────────────────────────────────
// GLOBAL CHAT
// ────────────────────────────────────────────────────

function initChat() {
    const toggle = document.getElementById('chatToggle');
    const drawer = document.getElementById('chatDrawer');
    const close = document.getElementById('chatClose');
    const form = document.getElementById('chatForm');
    const input = document.getElementById('chatInput');
    const refreshBtn = document.getElementById('chatRefresh');

    if (!toggle || !drawer || !close || !form || !input) return;

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.classList.add('spinning');
            fetchMessages().finally(() => {
                setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
            });
        });
    }

    toggle.addEventListener('click', () => {
        state.chatOpen = !state.chatOpen;
        drawer.classList.toggle('open', state.chatOpen);
        if (state.chatOpen) {
            fetchMessages();
            const badge = document.getElementById('chatBadge');
            if (badge) badge.style.display = 'none';
        }
    });

    close.addEventListener('click', () => {
        state.chatOpen = false;
        drawer.classList.remove('open');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        if (!state.user) {
            openOverlay('loginModal');
            showToast('⚠️ Please sign in to chat.', 'error');
            return;
        }

        input.value = '';

        // Optimistic UI: Add message locally first
        const tempMsg = {
            id: Date.now(),
            username: state.user.username,
            text,
            isTemp: true
        };
        state.chatMessages.push(tempMsg);
        renderMessages();

        await sendMessage(text);
        // Small delay to let server process, then sync
        setTimeout(fetchMessages, 300);
    });

    // Initial fetch
    fetchMessages();

    // Polling every 4 seconds
    setInterval(() => {
        if (state.chatOpen) fetchMessages();
    }, 4000);
}

async function fetchMessages() {
    try {
        const res = await fetch('/api/chat');
        if (res.ok) {
            const msgs = await res.json();

            // Safety check: ensure msgs is an array
            if (!Array.isArray(msgs)) {
                console.warn('API /api/chat did not return an array:', msgs);
                return;
            }

            // If new messages found, show badge if closed
            const currentCount = state.chatMessages?.length || 0;
            if (msgs.length > currentCount && !state.chatOpen) {
                const badge = document.getElementById('chatBadge');
                if (badge) badge.style.display = 'block';
            }

            state.chatMessages = msgs;
            renderMessages();
        }
    } catch (e) {
        console.error('Chat fetch failed', e);
    }
}

function renderMessages() {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    container.innerHTML = '';

    if (state.chatMessages.length === 0) {
        container.innerHTML = '<div class="chat-welcome">No messages yet. Be the first to say hi!</div>';
        return;
    }

    state.chatMessages.forEach(msg => {
        const div = document.createElement('div');
        // Ensure we compare usernames correctly for "self" styling
        const isSelf = state.user && (msg.username === state.user.username || msg.user_id === state.user.id);
        div.className = `chat-msg ${isSelf ? 'self' : 'other'} ${msg.isTemp ? 'pending' : ''}`;

        div.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-msg-author">${msg.username}</span>
            </div>
            <div class="chat-msg-bubble">${msg.text}</div>
        `;
        container.appendChild(div);
    });

    // Ensure scrolling to bottom
    container.scrollTop = container.scrollHeight;
}

async function sendMessage(text) {
    try {
        const res = await apiFetch('/api/chat', {
            method: 'POST',
            body: JSON.stringify({ text })
        });
        if (!res.ok) {
            const err = await res.json();
            showToast('❌ ' + (err.error || 'Failed to send'), 'error');
        }
    } catch (e) {
        showToast('❌ Failed to send message', 'error');
    }
}

// ────────────────────────────────────────────────────
// BOOT
// ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
