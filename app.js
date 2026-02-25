/* ===================================================
   MemeVault – Application Logic
   =================================================== */

// ────────────────────────────────────────────────────
// DATA
// ────────────────────────────────────────────────────

let POSTS_DATA = [];

// ────────────────────────────────────────────────────
// STATE & PERSISTENCE
// ────────────────────────────────────────────────────

async function loadState() {
    let posts = [];
    const savedUser = localStorage.getItem('memevault_user');
    const isLoggedIn = !!savedUser;

    try {
        const res = await fetch(`/api/posts?loggedIn=${isLoggedIn}&limit=6&offset=0`);
        if (res.ok) {
            posts = await res.json();
        }
    } catch (e) {
        console.error('Failed to load posts from API', e);
    }

    return {
        posts: posts,
        currentPost: null,
        activeCat: 'all',
        activeSort: 'hot',
        user: savedUser ? JSON.parse(savedUser) : null,
        hasMore: posts.length >= 6,
    };
}

let state = {
    posts: [],
    currentPost: null,
    activeCat: 'all',
    activeSort: 'hot',
    user: null,
    hasMore: true,
};

// ... Wait to override state later in init().


function saveState() {
    localStorage.setItem('memevault_posts', JSON.stringify(state.posts));
    localStorage.setItem('memevault_user', JSON.stringify(state.user));
}

// Detect if we're running via the local Express server
const SERVER_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? '' // same origin – use relative paths
    : null; // null means file:// – no server

// ────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────

function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
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
      <img src="${post.image}" alt="${post.title}" loading="lazy" />
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

    if (post.userVote === dir) {
        // undo vote
        post.upvotes += dir === 'up' ? -1 : 1;
        post.userVote = null;

        // Optimistic UI, but still call the API
        const oppositeDir = dir === 'up' ? 'down' : 'up';
        fetch(`/api/posts/${id}/upvote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: oppositeDir })
        });

    } else {
        if (post.userVote) {
            post.upvotes += post.userVote === 'up' ? -1 : 1;
            // also undo the previous on backend...
            const undir = post.userVote === 'up' ? 'down' : 'up';
            fetch(`/api/posts/${id}/upvote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: undir })
            });
        }
        post.upvotes += dir === 'up' ? 1 : -1;
        post.userVote = dir;

        fetch(`/api/posts/${id}/upvote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir })
        });
    }

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

    showToast(dir === 'up' ? '🔥 Upvoted!' : '👎 Downvoted!', dir === 'up' ? 'success' : '');
}

// ────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────

function handleSave(id) {
    if (!state.user) {
        openOverlay('loginModal');
        showToast('⚠️ Please sign in to save posts.', 'error');
        return;
    }

    const post = state.posts.find(p => p.id === id);
    if (!post) return;
    post.saved = !post.saved;
    saveState();
    refreshFilteredFeed();
    showToast(post.saved ? '🔖 Post saved!' : '🗑️ Removed from saved', post.saved ? 'success' : '');
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
// FILTER & SORT
// ────────────────────────────────────────────────────

function getFilteredPosts() {
    let posts = [...state.posts];

    // Category filter (simple mapping)
    if (state.activeCat !== 'all') {
        const catMap = {
            funny: 'Funny', gaming: 'Gaming', anime: 'Anime',
            wholesome: 'Wholesome', animals: 'Animals', dark: 'Dark Humor',
            programming: 'Programming', relationship: 'Relationship', sports: 'Sports'
        };
        const catLabel = catMap[state.activeCat];
        if (catLabel) posts = posts.filter(p => p.category === catLabel);
    }

    // Sort
    if (state.activeSort === 'hot') posts.sort((a, b) => b.upvotes - a.upvotes);
    else if (state.activeSort === 'new') posts.sort((a, b) => b.id - a.id);

    else if (state.activeSort === 'top') posts.sort((a, b) => (b.upvotes + b.comments) - (a.upvotes + a.comments));

    return posts;
}

function refreshFilteredFeed() {
    renderPosts(getFilteredPosts());
}

// ────────────────────────────────────────────────────
// POST MODAL
// ────────────────────────────────────────────────────

function openPost(id) {
    const post = state.posts.find(p => p.id === id);
    if (!post) return;
    state.currentPost = post;

    document.getElementById('modalImg').src = post.image;
    document.getElementById('modalImg').alt = post.title;
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

    // Tags
    const tagsEl = document.getElementById('modalTags');
    tagsEl.innerHTML = post.tags.map(t => `<span class="post-tag">${t}</span>`).join('');

    // Comments
    renderComments(post);

    openOverlay('postModal');
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
function handleGoogleCredential(response) {
    try {
        // Decode the JWT payload (Base64url → JSON)
        const payload = JSON.parse(
            atob(response.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        );

        loginUser({
            username: payload.name || payload.email,
            email: payload.email,
            picture: payload.picture || '',
            provider: 'google',
        });
    } catch (err) {
        console.error('Google credential decode failed:', err);
        showToast('⚠️ Google sign-in failed. Try again.', 'error');
    }
}

// Expose globally so the GIS library can call it via data-callback
window.handleGoogleCredential = handleGoogleCredential;

// ────────────────────────────────────────────────────
// LOGIN / USER
// ────────────────────────────────────────────────────

/**
 * @param {string|{username,email,picture,provider}} userInfo
 *   Pass a plain string for username/password login, or an object for OAuth.
 */
function loginUser(userInfo) {
    if (typeof userInfo === 'string') {
        state.user = { username: userInfo, email: '', picture: '', provider: 'local' };
    } else {
        state.user = userInfo;
    }

    const { username, picture, provider } = state.user;

    // Hide sign-in button, show avatar
    document.getElementById('loginBtn').style.display = 'none';
    const aw = document.getElementById('avatarMenu');
    aw.style.display = 'flex';

    // Avatar: use real Google profile picture if available, else a generated one
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
    if (!userInfo.isInit) {
        showToast(`👋 Welcome, ${username}${providerLabel}!`, 'success');
    }
    closeOverlay('loginModal');
}

function logoutUser() {
    // Revoke Google token if signed in via Google
    if (state.user && state.user.provider === 'google' && window.google && google.accounts) {
        try {
            google.accounts.id.disableAutoSelect();
        } catch (e) { /* ignore if GIS not loaded */ }
    }

    state.user = null;
    saveState();
    document.getElementById('loginBtn').style.display = '';
    document.getElementById('avatarMenu').style.display = 'none';

    // Reset comment avatar
    const commentAv = document.querySelector('.user-avatar-small');
    if (commentAv) commentAv.textContent = '😎';

    showToast('👋 Signed out. See ya!');
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
    btnText.textContent = 'Loading…';

    try {
        const isLoggedIn = !!state.user;
        const res = await fetch(`/api/posts?loggedIn=${isLoggedIn}&limit=6&offset=${state.posts.length}`);
        if (res.ok) {
            const newPosts = await res.json();
            if (newPosts.length < 6) {
                state.hasMore = false;
            }
            state.posts = [...state.posts, ...newPosts];
            saveState();
            refreshFilteredFeed();

            if (!state.hasMore) {
                btnText.textContent = "no more memes, please post more";
                btn.disabled = true;
                btn.style.opacity = '0.7';
                btn.style.cursor = 'default';
            } else {
                btnText.textContent = 'Load More';
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
        const res = await fetch('/api/stats');
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
// NAVBAR SCROLL EFFECT
// ────────────────────────────────────────────────────

function initScrollEffects() {
    const navbar = document.getElementById('navbar');
    const scrollBtn = document.getElementById('scrollTop');

    const mainContent = document.querySelector('.main-content');
    mainContent.addEventListener('scroll', () => {
        const y = mainContent.scrollTop;
        navbar.classList.toggle('scrolled', y > 10);
        scrollBtn.classList.toggle('visible', y > 300);
    });

    scrollBtn.addEventListener('click', () => mainContent.scrollTo({ top: 0, behavior: 'smooth' }));
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

            if (SERVER_URL !== null) {
                // ── Server mode: POST file to /api/upload ──────────────────
                const formData = new FormData();
                formData.append('file', pendingFile);

                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                if (!res.ok) throw new Error(`Server upload failed: ${res.status}`);
                const data = await res.json();
                imageUrl = data.url; // e.g. /uploads/1700000000-123456.png
            } else {
                // ── Fallback (file:// mode): use object URL (session only) ─
                imageUrl = URL.createObjectURL(pendingFile);
                showToast('⚠️ Open via http://localhost:8080 for permanent file saves.', '');
            }

            let newPost = {
                id: Date.now(), // fallback
                title,
                category: cat.charAt(0).toUpperCase() + cat.slice(1),
                image: imageUrl,
                author,
                authorPic,
                tags
            };

            if (SERVER_URL !== null) {
                // Save post to the database
                const postRes = await fetch('/api/posts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newPost)
                });
                if (postRes.ok) {
                    const postData = await postRes.json();
                    newPost.id = postData.id;
                }
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

    document.getElementById('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('loginUsername').value.trim() || 'MemeUser';
        loginUser(user);
    });
    document.getElementById('signupForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('signupUsername').value.trim() || 'NewMemer';
        loginUser(user);
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
    document.getElementById('logoutBtn').addEventListener('click', (e) => { e.preventDefault(); logoutUser(); });

    // Join community
    document.getElementById('joinBtn').addEventListener('click', () => {
        if (!state.user) { openOverlay('loginModal'); return; }
        showToast('🎉 You joined the community!', 'success');
    });

    // Hamburger / sidebar toggle
    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    // Keyboard ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeOverlay('postModal');
            closeOverlay('uploadModal');
            closeOverlay('loginModal');
            document.getElementById('sidebar').classList.remove('open');
        }
    });
}

// ────────────────────────────────────────────────────
// BOOT
// ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
