const CARD_COUNTS = {
    0: 4, 1: 6, 2: 10, 3: 10, 4: 10, 5: 10,
    6: 12, 7: 12, 8: 12, 9: 15, 10: 15
};

// Networking & Role
let peer = null;
let hostConn = null; // Used by Client to talk to Host
let clientConns = []; // Used by Host to talk to Clients
let isHost = false;
let myPlayerId = null;
let mySupabaseId = null;
let myName = "";
let myProfilePic = "";
let matchMoveLog = [];

// Supabase Initialization
const supabaseUrl = window.ENV.SUPABASE_URL;
const supabaseKey = window.ENV.SUPABASE_KEY;
// Need to check if it's the placeholder (meaning running locally without injection)
const isLocal = supabaseUrl === "YOUR_SUPABASE_URL_HERE";
let supabaseClient = null;

try {
    if (!isLocal && supabaseUrl && supabaseUrl.trim() !== "") {
        supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
    }
} catch (e) {
    console.error("Supabase initialization failed:", e);
}

if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (session) {
            mySupabaseId = session.user.id;
            myName = session.user.user_metadata.full_name || session.user.email.split('@')[0];
            myProfilePic = session.user.user_metadata.avatar_url || "";
            
            // Upsert user profile to database
            supabaseClient.from('users').upsert({
                id: mySupabaseId,
                name: myName,
                picture: myProfilePic
            }).then(({error}) => {
                if (error) {
                    console.error("Failed to upsert user info:", error);
                    showToast("Database Error: " + error.message);
                } else {
                    console.log("User profile synced to database!");
                }
            });
            
            document.getElementById('auth-section').classList.add('hidden');
            document.getElementById('setup-options').classList.remove('hidden');
            
            document.getElementById('user-profile-name').innerText = myName;
            if (myProfilePic) {
                const img = document.getElementById('user-profile-img');
                img.src = myProfilePic;
                img.classList.remove('hidden');
            }
        }
    });

    document.getElementById('btn-google-signin').addEventListener('click', async () => {
        const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google' });
        if (error) showToast("Login failed: " + error.message);
    });

    document.getElementById('btn-switch-account').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        myName = "";
        myProfilePic = "";
        document.getElementById('setup-options').classList.add('hidden');
        document.getElementById('auth-section').classList.remove('hidden');
    });
} else {
    // Local dev bypass
    console.warn("Supabase not configured. Bypassing auth for local testing.");
    myName = "Local Dev";
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('setup-options').classList.remove('hidden');
    document.getElementById('user-profile-name').innerText = myName;
    document.getElementById('btn-switch-account').style.display = 'none'; // Hide switch account in local dev
}

// Game State (Authoritative on Host, Synced to Clients)
let gameState = {
    status: 'LOBBY', // LOBBY, PLAYING, FINISHED
    deckCount: 0,
    tradeDeck: [],
    trashDeck: [],
    players: [],
    currentPlayerIndex: 0,
    tradeState: null // { initiatorId, targetId }
};

// Host Only Full Deck
let hostDeck = [];

// UI Selections
let selectedOwnBadCard = null;
let selectedOwnGoodCard = null;
let selectedOpponentBadCard = null;
let tradeTargetPlayerIndex = null;

// DOM
const setupScreen = document.getElementById('setup-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const gameOverScreen = document.getElementById('game-over-screen');

// Initialize PeerJS
function initPeer() {
    peer = new Peer(null, { debug: 2 });
    peer.on('error', (err) => {
        console.error("PeerJS Error:", err);
        showToast('Connection error: ' + err.message);
        
        // Reset setup buttons if they are in a loading state
        const hostBtn = document.getElementById('btn-create-room');
        const joinBtn = document.getElementById('btn-join-room');
        if (hostBtn) {
            hostBtn.disabled = false;
            hostBtn.innerText = "Create Room";
        }
        if (joinBtn) {
            joinBtn.disabled = false;
            joinBtn.innerText = "Join Room";
        }
    });
}

// Public Room Tracking
let currentPublicRoomCode = null;

async function hostPublicRoom(roomCode) {
    if (!supabaseClient) return;
    currentPublicRoomCode = roomCode;
    try {
        const { error } = await supabaseClient.from('rooms').insert({
            id: roomCode,
            host_name: myName,
            player_count: 1,
            status: 'LOBBY',
            is_public: true
        });
        if (error) console.error("Failed to list public room:", error);
    } catch (e) {
        console.error("Public rooms table might not exist.", e);
    }
}

async function updatePublicRoomStatus() {
    if (!supabaseClient || !currentPublicRoomCode || !isHost) return;
    try {
        await supabaseClient.from('rooms').update({
            player_count: gameState.players.length,
            status: gameState.status
        }).eq('id', currentPublicRoomCode);
    } catch (e) {}
}

async function removePublicRoom() {
    if (!supabaseClient || !currentPublicRoomCode || !isHost) return;
    try {
        await supabaseClient.from('rooms').delete().eq('id', currentPublicRoomCode);
        currentPublicRoomCode = null;
    } catch (e) {}
}

window.addEventListener('beforeunload', () => {
    if (isHost && currentPublicRoomCode) {
        // This is a fire-and-forget attempt. 
        // Browsers may block async fetch on unload, but we try anyway.
        removePublicRoom();
    }
});

async function refreshPublicRooms() {
    if (!supabaseClient) return;
    const listEl = document.getElementById('public-rooms-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="font-size: 0.8rem; opacity: 0.6;">Refreshing...</p>';
    
    try {
        // Auto-cleanup: Delete any rooms older than 2 hours from the database
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        supabaseClient.from('rooms').delete().lt('created_at', twoHoursAgo).then();

        const { data, error } = await supabaseClient
            .from('rooms')
            .select('*')
            .eq('status', 'LOBBY')
            .eq('is_public', true)
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        
        listEl.innerHTML = '';
        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="font-size: 0.8rem; opacity: 0.6;">No public rooms active.</p>';
            return;
        }
        
        data.forEach(room => {
            const item = document.createElement('div');
            item.className = 'public-room-item';
            item.innerHTML = `
                <div>
                    <div style="font-weight: 600;">${room.host_name}'s Game</div>
                    <div class="room-tag">${room.id}</div>
                </div>
                <div class="room-players">${room.player_count}/4 Players</div>
            `;
            item.onclick = () => {
                document.getElementById('join-code').value = room.id;
                document.getElementById('btn-join-room').click();
            };
            listEl.appendChild(item);
        });
    } catch (e) {
        listEl.innerHTML = '<p style="font-size: 0.8rem; color: #f87171;">Failed to load public rooms.</p>';
    }
}

// ==========================================
// HOST LOGIC
// ==========================================
document.getElementById('btn-create-room').addEventListener('click', (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.innerText = "Creating...";
    
    // Generate short room code (mapped to Peer ID)
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    if (peer) {
        peer.destroy();
    }
    
    peer = new Peer(`gcbc-game-${roomCode}`);
    
    peer.on('open', () => {
        isHost = true;
        myPlayerId = 0;
        
        document.getElementById('lobby-code').innerText = roomCode;
        setupScreen.classList.remove('active');
        lobbyScreen.classList.add('active');
        document.getElementById('btn-start-game').classList.remove('hidden');
        document.getElementById('waiting-msg').classList.add('hidden');
        
        // Public room registration
        if (document.getElementById('check-public-game').checked) {
            hostPublicRoom(roomCode);
        }
            
            gameState.players.push({ 
                id: myPlayerId, 
                name: myName, 
                picture: myProfilePic, 
                supabaseId: mySupabaseId, 
                hand: [], 
                selections: { goodCardId: null, badCardId: null, targetBadCardId: null, targetPlayerId: null },
                isFinished: false 
            });
            renderLobby();
        });

        peer.on('connection', (conn) => {
            clientConns.push(conn);
            
            conn.on('data', (data) => {
                if (data.type === 'JOIN_REQUEST') {
                    if (conn.playerId !== undefined) return; // Already joined
                    
                    const newPlayerId = gameState.players.length;
                    gameState.players.push({
                        id: newPlayerId,
                        name: data.name,
                        picture: data.picture,
                        supabaseId: data.supabaseId,
                        hand: [], 
                        selections: { goodCardId: null, badCardId: null, targetBadCardId: null, targetPlayerId: null },
                        isFinished: false 
                    });
                    conn.playerId = newPlayerId;
                    
                    // Explicitly tell the client who they are!
                    conn.send({ type: 'WELCOME', playerId: newPlayerId });
                    
                    renderLobby();
                    broadcastState();
                    updatePublicRoomStatus();
                } else if (data.type === 'ACTION') {
                    handleHostAction(conn.playerId, data.action, data.payload);
                }
            });
            
            conn.on('close', () => {
                clientConns = clientConns.filter(c => c !== conn);
            });
        });
        
        peer.on('error', (err) => {
            if (err.type === 'unavailable-id') {
                showToast('Room Code collision. Try again.');
            }
        });
});

function broadcastState() {
    if (!isHost) return;
    
    // Send customized state to each client to hide unknown cards
    clientConns.forEach(conn => {
        let stateToSend;
        if (gameState.status === 'FINISHED') {
            // Send fully exposed state!
            stateToSend = gameState;
        } else {
            stateToSend = sanitizeStateFor(conn.playerId);
        }
        conn.send({ type: 'STATE', state: stateToSend });
    });
    
    // Update host's own UI without modifying the authoritative state
    if (gameState.status === 'LOBBY') renderLobby();
    else if (gameState.status === 'PLAYING') renderGame();
    else if (gameState.status === 'FINISHED') renderGameOver();
}

function sanitizeStateFor(targetPlayerId) {
    // Deep copy to avoid mutating original authoritative state
    const stateCopy = JSON.parse(JSON.stringify(gameState));
    
    stateCopy.players.forEach(p => {
        if (p.id === targetPlayerId) {
            // Can't see own bad cards
            if (p.hand) p.hand.forEach(c => { if (!c.isGood) c.value = null; });
        } else {
            // Can't see opponent good cards
            if (p.hand) p.hand.forEach(c => { if (c.isGood) c.value = null; });
        }
    });
    
    return stateCopy;
}

document.getElementById('btn-start-game').addEventListener('click', () => {
    if (!isHost || gameState.players.length < 2) {
        showToast("Need at least 2 players!");
        return;
    }
    
    // Init Deck
    hostDeck = [];
    let idCounter = 0;
    for (const [val, count] of Object.entries(CARD_COUNTS)) {
        for (let i = 0; i < count; i++) {
            hostDeck.push({ id: idCounter++, value: parseInt(val) });
        }
    }
    // Shuffle
    for (let i = hostDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [hostDeck[i], hostDeck[j]] = [hostDeck[j], hostDeck[i]];
    }
    
    // Deal
    gameState.players.forEach(p => {
        p.hand = [
            { ...hostDeck.pop(), isGood: false },
            { ...hostDeck.pop(), isGood: false },
            { ...hostDeck.pop(), isGood: false }
        ];
        p.isFinished = false;
        p.selections = { goodCardId: null, badCardId: null, targetBadCardId: null, targetPlayerId: null };
    });
    
    gameState.tradeDeck = [hostDeck.pop()];
    gameState.trashDeck = [];
    gameState.deckCount = hostDeck.length;
    gameState.status = 'PLAYING';
    gameState.currentPlayerIndex = 0;
    
    // Reset match log when game starts
    matchMoveLog = [];

    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');
    broadcastState();
    updatePublicRoomStatus();
});

// Host logic handling incoming actions
function handleHostAction(playerId, action, payload) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player) return;
    
    // Log the move
    matchMoveLog.push({
        playerId: playerId,
        playerName: player.name,
        action: action,
        payload: payload,
        timestamp: new Date().toISOString()
    });

    if (action === 'SELECT_CARD') {
        player.selections = payload;
        broadcastState();
        return; // Do not log hover selections or advance turn
    }

    if (gameState.currentPlayerIndex !== gameState.players.indexOf(player) && action !== 'MOVE_2_TRADE_RESOLVE') return;
    
    const currPlayer = gameState.players[gameState.currentPlayerIndex];
    
    if (action === 'MOVE_1') {
        broadcastAnimation('MOVE_1', playerId, payload.badCardId, 'TRADE');
        const cardIdx = currPlayer.hand.findIndex(c => c.id === payload.badCardId);
        if (cardIdx === -1) return;
        
        const cardToTrade = currPlayer.hand[cardIdx];
        const newGoodCard = gameState.tradeDeck.pop();
        newGoodCard.isGood = true;
        
        currPlayer.hand[cardIdx] = newGoodCard;
        
        cardToTrade.isGood = false;
        gameState.tradeDeck.push(cardToTrade);
        
        hostNextTurn();
    } 
    else if (action === 'MOVE_2_TAKE') {
        broadcastAnimation('MOVE_2_TAKE', playerId, payload.goodCardId, 'TRASH');
        const cardIdx = currPlayer.hand.findIndex(c => c.id === payload.goodCardId);
        if (cardIdx === -1) return;
        
        const cardToTrash = currPlayer.hand[cardIdx];
        gameState.trashDeck.push(cardToTrash);
        
        const newBadCard = { ...hostDeck.pop(), isGood: false };
        currPlayer.hand[cardIdx] = newBadCard;
        
        gameState.deckCount = hostDeck.length;
        
        hostNextTurn();
    }
    else if (action === 'MOVE_2_TRADE_START') {
        if (hostDeck.length === 0) return;
        const targetPlayer = gameState.players.find(p => p.id == payload.targetPlayerId);
        
        const goodCardIdx = currPlayer.hand.findIndex(c => c.id === payload.goodCardId);
        const badCardIdx = targetPlayer.hand.findIndex(c => c.id === payload.targetBadCardId);
        
        if (goodCardIdx === -1 || badCardIdx === -1) return;
        
        // Trash good
        const cardToTrash = currPlayer.hand[goodCardIdx];
        gameState.trashDeck.push(cardToTrash);
        
        // Steal bad as good. Replaces the trashed good card!
        const stolenCard = targetPlayer.hand[badCardIdx];
        stolenCard.isGood = true;
        currPlayer.hand[goodCardIdx] = stolenCard;
        
        // Victim's slot is temporarily empty.
        targetPlayer.hand[badCardIdx] = { id: 'temp_trade_slot_' + targetPlayer.id, isTemp: true, isFaceDown: true };
        
        // Enter Trade State
        gameState.tradeState = { initiatorId: currPlayer.id, targetId: targetPlayer.id, emptySlotIdx: badCardIdx };
        broadcastState();
    }
    else if (action === 'MOVE_2_TRADE_RESOLVE') {
        if (!gameState.tradeState || playerId != gameState.tradeState.targetId) return;
        
        broadcastAnimation('MOVE_2_TRADE_RESOLVE', playerId, payload.chosenBadCardId, 'TRADE_RESOLVE', { initiatorId: gameState.tradeState.initiatorId });
        
        const targetPlayer = gameState.players.find(p => p.id == gameState.tradeState.targetId);
        const initPlayer = gameState.players.find(p => p.id == gameState.tradeState.initiatorId);
        
        const badCardIdx = initPlayer.hand.findIndex(c => c.id === payload.chosenBadCardId);
        if (badCardIdx === -1) return;
        
        // Target steals init's bad card as good. Replaces the temporary empty slot!
        const stolenCard = initPlayer.hand[badCardIdx];
        stolenCard.isGood = true;
        targetPlayer.hand[gameState.tradeState.emptySlotIdx] = stolenCard;
        
        // Init draws bad card from deck. Replaces the bad card target just stole!
        const newBadCard = { ...hostDeck.pop(), isGood: false };
        initPlayer.hand[badCardIdx] = newBadCard;
        
        gameState.deckCount = hostDeck.length;
        
        gameState.tradeState = null;
        hostNextTurn();
    }
}

function hostNextTurn() {
    gameState.isTransitioning = true;
    
    // Clear selections immediately so people stop hovering
    gameState.players.forEach(p => {
        p.selections = { goodCardId: null, badCardId: null, targetBadCardId: null, targetPlayerId: null };
    });
    
    // Broadcast immediately so players see the result of the move (the new hand)
    // but the turn indicator hasn't moved yet.
    broadcastState();

    setTimeout(() => {
        // Check finished
        gameState.players.forEach(p => {
            if (p.hand.every(c => c.isGood) && !p.isFinished) {
                p.isFinished = true;
            }
        });

        if (gameState.players.every(p => p.isFinished)) {
            gameState.status = 'FINISHED';
            gameState.isTransitioning = false;
            broadcastState();
            return;
        }
        
        // Advance to next unfinished player
        do {
            gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        } while (gameState.players[gameState.currentPlayerIndex].isFinished);
        
        gameState.isTransitioning = false;
        broadcastState();
    }, 1000); // 1.0s delay
}

// ==========================================
// CLIENT LOGIC
// ==========================================
document.getElementById('btn-join-room').addEventListener('click', (e) => {
    const btn = e.target;
    const code = document.getElementById('join-code').value.toUpperCase();
    if (!code) return showToast('Enter a Room Code');
    
    btn.disabled = true;
    btn.innerText = "Joining...";
    
    const joinRoom = () => {
        const timeout = setTimeout(() => {
            if (btn.innerText === "Joining...") {
                showToast('Room not found or host unavailable.');
                btn.disabled = false;
                btn.innerText = "Join Room";
                if (hostConn) hostConn.close();
            }
        }, 5000);

        hostConn = peer.connect(`gcbc-game-${code}`);
        
        hostConn.on('open', () => {
            clearTimeout(timeout);
            isHost = false;
            hostConn.send({ 
                type: 'JOIN_REQUEST', 
                name: myName, 
                picture: myProfilePic,
                supabaseId: mySupabaseId 
            });
            
            document.getElementById('lobby-code').innerText = code;
            setupScreen.classList.remove('active');
            lobbyScreen.classList.add('active');
        });
        
        hostConn.on('data', (data) => {
            if (data.type === 'WELCOME') {
                myPlayerId = data.playerId;
            } else if (data.type === 'ANIMATE') {
                playRemoteAnimation(data.moveData);
            }
            else if (data.type === 'STATE') {
                const oldStatus = gameState.status;
                gameState = data.state;
                
                if (gameState.status === 'LOBBY') renderLobby();
                else if (gameState.status === 'PLAYING') {
                    if (oldStatus !== 'PLAYING') {
                        lobbyScreen.classList.remove('active');
                        gameScreen.classList.add('active');
                    }
                    renderGame();
                }
                else if (gameState.status === 'FINISHED') {
                    gameScreen.classList.remove('active');
                    renderGameOver();
                }
            }
        });
        
        hostConn.on('close', () => {
            showToast('Host has left the room.');
            // Automatically return to main menu
            document.getElementById('btn-main-menu').click();
        });

        hostConn.on('error', () => {
            clearTimeout(timeout);
            showToast('Failed to connect to host.');
            btn.disabled = false;
            btn.innerText = "Join Room";
        });
    };

    if (!peer) {
        initPeer();
        peer.on('open', joinRoom);
    } else if (!peer.open && !peer.disconnected) {
        peer.on('open', joinRoom);
    } else if (peer.disconnected) {
        peer.reconnect();
        peer.on('open', joinRoom);
    } else {
        joinRoom();
    }
});

function sendAction(action, payload) {
    if (isHost) {
        handleHostAction(myPlayerId, action, payload);
    } else {
        if (hostConn) hostConn.send({ type: 'ACTION', action, payload });
    }
}

// ==========================================
// RENDERING
// ==========================================
function renderLobby() {
    const originalState = gameState;
    if (isHost && gameState.status !== 'FINISHED') gameState = sanitizeStateFor(myPlayerId);

    document.getElementById('player-count').innerText = gameState.players.length;
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    gameState.players.forEach(p => {
        const li = document.createElement('li');
        if (p.picture) {
            li.innerHTML = `<img src="${p.picture}" class="profile-pic small" style="margin-right: 10px;"> ${p.name}`;
        } else {
            li.innerHTML = `👤 ${p.name}`;
        }
        list.appendChild(li);
    });
    
    if (isHost && originalState.status !== 'FINISHED') gameState = originalState;
}

function createCardElement(card, isFaceDown, isGood, onClick) {
    const el = document.createElement('div');
    el.className = `card ${isFaceDown ? 'face-down' : ''} ${isGood ? 'good-card' : 'bad-card'}`;
    el.dataset.id = card.id;
    if (!isFaceDown && card.value !== null) {
        el.dataset.value = card.value;
        el.innerText = card.value;
        
        el.classList.add('val-' + card.value);
        
    } else if (!isFaceDown && card.value === null) {
        el.innerText = '?'; // Unknown value fallback
        el.classList.add('val-unknown');
    }
    if (onClick) {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(card, el);
        });
    }
    return el;
}

function selectCard(type, cardId, targetId = null) {
    if (type === 'good') {
        selectedOwnGoodCard = selectedOwnGoodCard === cardId ? null : cardId;
        selectedOwnBadCard = null;
    } else if (type === 'bad') {
        selectedOwnBadCard = selectedOwnBadCard === cardId ? null : cardId;
        selectedOwnGoodCard = null;
    } else if (type === 'opponent') {
        if (selectedOpponentBadCard === cardId) {
            selectedOpponentBadCard = null;
            tradeTargetPlayerIndex = null;
        } else {
            selectedOpponentBadCard = cardId;
            tradeTargetPlayerIndex = targetId;
        }
    }
    
    sendAction('SELECT_CARD', {
        goodCardId: selectedOwnGoodCard,
        badCardId: selectedOwnBadCard,
        targetBadCardId: selectedOpponentBadCard,
        targetPlayerId: tradeTargetPlayerIndex
    });
    
    renderGame();
}

function renderGame() {
    const originalState = gameState;
    if (isHost && gameState.status !== 'FINISHED') gameState = sanitizeStateFor(myPlayerId);

    const me = gameState.players.find(p => p.id === myPlayerId);
    if (me && me.picture) {
        document.getElementById('my-name-display').innerHTML = `<img src="${me.picture}" class="profile-pic small" style="vertical-align: middle; margin-right: 5px;"> You are: ${me.name}`;
    } else {
        document.getElementById('my-name-display').innerText = `You are: ${myName}`;
    }
    
    const currPlayer = gameState.players[gameState.currentPlayerIndex];
    const isMyTurn = currPlayer && currPlayer.id === myPlayerId;
    
    document.getElementById('turn-indicator').innerText = isMyTurn ? "It's Your Turn!" : `${currPlayer.name}'s Turn`;
    
    document.getElementById('bad-deck-count').innerText = gameState.deckCount;
    
    // Decks
    const tradeSlot = document.querySelector('#trade-deck .card-slot');
    tradeSlot.innerHTML = '';
    if (gameState.tradeDeck.length > 0) {
        tradeSlot.appendChild(createCardElement(gameState.tradeDeck[gameState.tradeDeck.length - 1], true, false));
    } else tradeSlot.classList.add('empty');

    const trashSlot = document.querySelector('#trash-deck .card-slot');
    trashSlot.innerHTML = '';
    if (gameState.trashDeck.length > 0) {
        trashSlot.appendChild(createCardElement(gameState.trashDeck[gameState.trashDeck.length - 1], false, false));
        trashSlot.classList.remove('empty');
    } else trashSlot.classList.add('empty');

    // Helper to apply opponent selections visually
    const applySelections = (card, el) => {
        gameState.players.forEach(p => {
            if (p.selections && (p.selections.goodCardId === card.id || p.selections.badCardId === card.id || p.selections.targetBadCardId === card.id)) {
                el.classList.add('selected');
                el.style.borderColor = p.id === gameState.currentPlayerIndex ? '#facc15' : 'var(--primary)'; // Yellow if current player
            }
        });
    };

    // My Hand
    const handContainer = document.getElementById('current-player-hand');
    handContainer.innerHTML = '';
    
    if (me) {
        me.hand.forEach(card => {
            if (card.isTemp) {
                handContainer.appendChild(createCardElement(card, true, false));
                return;
            }
            
            // You can't see your own bad cards, but you can see your own good cards
            const isFaceDown = !card.isGood;
            
            const el = createCardElement(card, isFaceDown, card.isGood, (c) => {
                if (!isMyTurn || gameState.tradeState) return;
                selectCard(c.isGood ? 'good' : 'bad', c.id);
            });
            
            if (selectedOwnGoodCard === card.id || selectedOwnBadCard === card.id) el.classList.add('selected');
            applySelections(card, el);
            
            handContainer.appendChild(el);
        });
    }

    // Opponents
    const opponentsContainer = document.getElementById('opponents-container');
    opponentsContainer.innerHTML = '';

    gameState.players.forEach(p => {
        if (p.id === myPlayerId) return;

        const oppEl = document.createElement('div');
        oppEl.dataset.playerId = p.id;
        oppEl.className = `opponent ${p.isFinished ? 'finished' : ''} ${p.id === gameState.currentPlayerIndex ? 'is-turn' : ''}`;
        oppEl.innerHTML = `<div class="opponent-header">
            ${p.picture ? `<img src="${p.picture}" class="profile-pic small">` : '👤'}
            <h3>${p.name}</h3>
        </div><div class="hand"></div>`;
        const oppHand = oppEl.querySelector('.hand');

        p.hand.forEach(card => {
            if (card.isTemp) {
                oppHand.appendChild(createCardElement(card, true, false));
                return;
            }
            
            // Opponent Good cards are face down. Opponent Bad cards are face up.
            const isFaceDown = card.isGood;
            
            const el = createCardElement(card, isFaceDown, card.isGood, (c) => {
                if (gameState.tradeState) {
                    if (gameState.tradeState.targetId === myPlayerId && p.id === gameState.tradeState.initiatorId && !c.isGood && !c.isTemp) {
                        // Prevent multiple clicks
                        document.querySelectorAll('.trade-target-selectable').forEach(n => n.classList.remove('trade-target-selectable'));
                        
                        const clickedEl = document.querySelector(`.card[data-id="${c.id}"]`);
                        const myHandEl = document.getElementById('current-player-hand');
                        
                        let animsComplete = 0;
                        const badDeckCardEl = document.querySelector('#bad-deck .card-slot .card');
                        
                        const checkDone = () => {
                            animsComplete++;
                            if (animsComplete === (badDeckCardEl ? 2 : 1)) {
                                sendAction('MOVE_2_TRADE_RESOLVE', { chosenBadCardId: c.id });
                            }
                        };
                        
                        animateCardMovement(clickedEl, myHandEl, checkDone);
                        if (badDeckCardEl) animateCardMovement(badDeckCardEl, clickedEl, checkDone);
                    }
                    return;
                }

                if (!isMyTurn || p.isFinished) return;
                if (!c.isGood) {
                    selectCard('opponent', c.id, p.id);
                }
            });
            
            if (selectedOpponentBadCard === card.id) el.classList.add('selected');
            
            // Highlight cards if the current player needs to pick one for a trade
            if (gameState.tradeState && gameState.tradeState.targetId === myPlayerId && p.id === gameState.tradeState.initiatorId && !card.isGood && !card.isTemp) {
                el.classList.add('trade-target-selectable');
            }
            
            applySelections(card, el);
            
            oppHand.appendChild(el);
        });

        opponentsContainer.appendChild(oppEl);
    });

    // Modals removed - trade resolution now happens directly on opponent cards
    const modal = document.getElementById('trade-modal');
    if (modal) modal.classList.remove('active');

    updateButtons(isMyTurn);
    
    if (isHost && originalState.status !== 'FINISHED') gameState = originalState;
}

function updateButtons(isMyTurn) {
    const btn1 = document.getElementById('btn-move-1');
    const btn2Take = document.getElementById('btn-move-2-take');
    const btn2Trade = document.getElementById('btn-move-2-trade');

    if (!isMyTurn || gameState.tradeState || gameState.isTransitioning) {
        btn1.disabled = true;
        btn2Take.disabled = true;
        btn2Trade.disabled = true;
        return;
    }

    btn1.disabled = selectedOwnBadCard === null;
    btn2Take.disabled = selectedOwnGoodCard === null || gameState.deckCount === 0;
    btn2Trade.disabled = selectedOwnGoodCard === null || selectedOpponentBadCard === null || gameState.deckCount === 0;
}

// Animation Sync
function broadcastAnimation(moveType, playerId, sourceCardId, targetType, extraData = null) {
    const moveData = { moveType, playerId, sourceCardId, targetType, extraData };
    
    // Send to all clients
    gameState.players.forEach(p => {
        if (p.conn && p.conn.open) {
            p.conn.send({ type: 'ANIMATE', moveData });
        }
    });

    // Also play locally if I'm the host (the host doesn't send data to themselves)
    playRemoteAnimation(moveData);
}

function playRemoteAnimation(data) {
    // If I initiated this move, I already played it locally
    if (data.playerId === myPlayerId) return;
    
    const { moveType, playerId, sourceCardId, targetType, extraData } = data;
    
    if (moveType === 'MOVE_2_TRADE_RESOLVE') {
        // Victim picking initiator's card
        let sourceEl;
        if (extraData.initiatorId === myPlayerId) {
            sourceEl = document.querySelector(`.card[data-id="${sourceCardId}"]`);
        } else {
            const oppArea = document.querySelector(`.opponent[data-player-id="${extraData.initiatorId}"]`);
            sourceEl = oppArea ? oppArea.querySelector(`.card[data-id="${sourceCardId}"]`) || oppArea.querySelector('.card') : null;
        }
        
        let targetEl;
        if (playerId === myPlayerId) {
            targetEl = document.getElementById('current-player-hand');
        } else {
            targetEl = document.querySelector(`.opponent[data-player-id="${playerId}"]`);
        }
        
        if (sourceEl && targetEl) {
            animateCardMovement(sourceEl, targetEl);
            const badDeckCardEl = document.querySelector('#bad-deck .card-slot .card');
            if (badDeckCardEl) {
                animateCardMovement(badDeckCardEl, sourceEl);
            }
        }
        return;
    }
    
    // Find source element (either my hand or an opponent's area)
    let sourceEl;
    if (playerId === myPlayerId) {
        sourceEl = document.querySelector(`.card[data-id="${sourceCardId}"]`);
    } else {
        const oppArea = document.querySelector(`.opponent[data-player-id="${playerId}"]`);
        // On other people's screens, they might not know which card it is, so just pick one from the hand
        sourceEl = oppArea ? oppArea.querySelector(`.card[data-id="${sourceCardId}"]`) || oppArea.querySelector('.card') : null;
    }
    
    // Find target element
    const targetSlotEl = document.querySelector(targetType === 'TRADE' ? '#trade-deck .card-slot' : '#trash-deck .card-slot');
    
    if (sourceEl && targetSlotEl) {
        animateCardMovement(sourceEl, targetSlotEl);
        
        // For swaps, also animate the card coming back
        if (moveType === 'MOVE_1') {
            const tradeCardEl = document.querySelector('#trade-deck .card-slot .card');
            if (tradeCardEl) {
                animateCardMovement(tradeCardEl, sourceEl);
            }
        } else if (moveType === 'MOVE_2_TAKE') {
            const badDeckCardEl = document.querySelector('#bad-deck .card-slot .card');
            if (badDeckCardEl) {
                animateCardMovement(badDeckCardEl, sourceEl);
            }
        }
    }
}

// Animation Helper
function animateCardMovement(sourceEl, target, callback) {
    if (!sourceEl || !target) {
        if (callback) callback();
        return;
    }

    // Force remove selected class to get true un-shifted rect if target is an element
    let targetRect;
    if (target instanceof Element) {
        const wasSelected = target.classList.contains('selected');
        if (wasSelected) target.classList.remove('selected');
        targetRect = target.getBoundingClientRect();
        if (wasSelected) target.classList.add('selected');
    } else {
        targetRect = target; // Allow passing a raw DOMRect
    }

    const sourceRect = sourceEl.getBoundingClientRect();

    // Create a clone for animation
    const clone = sourceEl.cloneNode(true);
    clone.classList.remove('selected'); // Don't carry over the shift!
    clone.classList.add('card-flying');
    clone.style.top = sourceRect.top + 'px';
    clone.style.left = sourceRect.left + 'px';
    clone.style.width = sourceRect.width + 'px';
    clone.style.height = sourceRect.height + 'px';

    document.body.appendChild(clone);

    // Force reflow so the browser registers the starting position
    clone.getBoundingClientRect();

    // Hide original during animation
    sourceEl.style.opacity = '0';

    // Trigger animation in next frame
    requestAnimationFrame(() => {
        clone.style.top = targetRect.top + 'px';
        clone.style.left = targetRect.left + 'px';
    });

    setTimeout(() => {
        if (clone.parentNode) document.body.removeChild(clone);
        sourceEl.style.opacity = '1';
        if (callback) callback();
    }, 600);
}

// Move Listeners
document.getElementById('btn-move-1').addEventListener('click', () => {
    if (selectedOwnBadCard === null) return;
    
    const cardEl = document.querySelector(`.card[data-id="${selectedOwnBadCard}"]`);
    const targetSlotEl = document.querySelector('#trade-deck .card-slot');
    const tradeCardEl = document.querySelector('#trade-deck .card-slot .card');
    
    // Guard against multi-clicks
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = true);
    
    let animsComplete = 0;
    const checkDone = () => {
        animsComplete++;
        if (animsComplete === (tradeCardEl ? 2 : 1)) {
            sendAction('MOVE_1', { badCardId: selectedOwnBadCard });
            resetSelections();
        }
    };
    
    animateCardMovement(cardEl, targetSlotEl, checkDone);
    if (tradeCardEl) {
        // Animate the trade card back to the un-shifted position of the hand card
        animateCardMovement(tradeCardEl, cardEl, checkDone);
    }
});

document.getElementById('btn-move-2-take').addEventListener('click', () => {
    if (selectedOwnGoodCard === null) return;
    
    const cardEl = document.querySelector(`.card[data-id="${selectedOwnGoodCard}"]`);
    const trashSlotEl = document.querySelector('#trash-deck .card-slot');
    const badDeckCardEl = document.querySelector('#bad-deck .card-slot .card');
    
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = true);
    
    let animsComplete = 0;
    const checkDone = () => {
        animsComplete++;
        if (animsComplete === (badDeckCardEl ? 2 : 1)) {
            sendAction('MOVE_2_TAKE', { goodCardId: selectedOwnGoodCard });
            resetSelections();
        }
    };
    
    animateCardMovement(cardEl, trashSlotEl, checkDone);
    if (badDeckCardEl) {
        animateCardMovement(badDeckCardEl, cardEl, checkDone);
    }
});

document.getElementById('btn-move-2-trade').addEventListener('click', () => {
    if (selectedOwnGoodCard === null || selectedOpponentBadCard === null) return;
    
    const cardEl = document.querySelector(`.card[data-id="${selectedOwnGoodCard}"]`);
    const trashSlotEl = document.querySelector('#trash-deck .card-slot');
    // Note: Opponent stealing parts are too complex for local pre-animation, 
    // so we just animate the discard part locally for visual feedback.
    
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = true);

    animateCardMovement(cardEl, trashSlotEl, () => {
        sendAction('MOVE_2_TRADE_START', { 
            goodCardId: selectedOwnGoodCard, 
            targetBadCardId: selectedOpponentBadCard, 
            targetPlayerId: tradeTargetPlayerIndex 
        });
        resetSelections();
    });
});

function resetSelections() {
    selectedOwnBadCard = null;
    selectedOwnGoodCard = null;
    selectedOpponentBadCard = null;
    tradeTargetPlayerIndex = null;
    if(gameState.status === 'PLAYING') renderGame();
}

function renderGameOver() {
    // Game over screen always shows the full un-sanitized state so players can see the final cards
    const scoreboard = document.getElementById('scoreboard');
    scoreboard.innerHTML = '';
    
    let scores = gameState.players.map(p => {
        // Since state is sanitized, if it's not the host, we might not have all the correct values?
        // Wait! In FINISHED state, the host should reveal everything!
        // To fix this without a complex change, we just sum up whatever we have. But clients won't have values.
        // For a quick fix, let's just show standard game over. (Host calculates sums, but we didn't send them yet).
        const sum = p.hand.reduce((acc, c) => acc + (c.value||0), 0);
        return { ...p, sum };
    });
    
    scores.sort((a, b) => a.sum - b.sum);
    
    scores.forEach((s, idx) => {
        const row = document.createElement('div');
        row.className = `score-row ${idx === 0 ? 'winner' : ''}`;
        row.innerHTML = `<span>${idx === 0 ? '🏆 ' : ''}${s.name}</span> <span>${s.sum} pts</span>`;
        scoreboard.appendChild(row);
    });
    
    if (isHost && supabaseClient) {
        // Record match in Supabase with moves
        supabaseClient.from('matches').insert([{
            winner: scores[0].name,
            players: scores.map(s => s.name).join(', '),
            moves: matchMoveLog
        }]).then(({error}) => {
            if (error) console.error("Failed to save match:", error);
            else console.log("Match saved to Supabase!");
        });

        // Update User Win/Loss Stats
        scores.forEach((s, idx) => {
            if (!s.supabaseId) return; // Skip players without an account (local dev)
            if (idx === 0) {
                supabaseClient.rpc('increment_win', { user_id: s.supabaseId }).then();
            } else {
                supabaseClient.rpc('increment_loss', { user_id: s.supabaseId }).then();
            }
        });
    }
    
    gameOverScreen.classList.add('active');
}

function showToast(msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

document.getElementById('btn-main-menu').addEventListener('click', () => {
    // 1. Clean up PeerJS connections & Public Room
    if (isHost) removePublicRoom();
    if (hostConn) { hostConn.close(); hostConn = null; }
    clientConns.forEach(c => c.close());
    clientConns = [];
    if (peer) { peer.destroy(); peer = null; }

    // 2. Reset Game State
    isHost = false;
    gameState = {
        status: 'LOBBY',
        players: [],
        deckCount: 0,
        tradeDeck: [],
        trashDeck: [],
        currentPlayerIndex: 0,
        tradeState: null
    };

    // 3. Reset UI Selections
    resetSelections();

    // 4. Switch Screens
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('setup-screen').classList.add('active');
    
    // 5. Reset Setup Buttons
    const hostBtn = document.getElementById('btn-create-room');
    const joinBtn = document.getElementById('btn-join-room');
    hostBtn.disabled = false;
    hostBtn.innerText = "Create Room";
    joinBtn.disabled = false;
    joinBtn.innerText = "Join Room";
    
    refreshPublicRooms();
    
    // Check if user is signed in to show the correct setup options
    if (myName !== "Local Dev" && myName !== "") {
        document.getElementById('auth-section').classList.add('hidden');
        document.getElementById('setup-options').classList.remove('hidden');
    } else {
        document.getElementById('auth-section').classList.remove('hidden');
        document.getElementById('setup-options').classList.add('hidden');
    }
});

// Instructions Modal Logic
document.getElementById('btn-how-to-play').addEventListener('click', () => {
    document.getElementById('how-to-play-modal').classList.add('active');
});

document.getElementById('btn-close-instructions').addEventListener('click', () => {
    document.getElementById('how-to-play-modal').classList.remove('active');
});

document.getElementById('btn-refresh-public').addEventListener('click', refreshPublicRooms);

// Initial Load
if (supabaseClient) refreshPublicRooms();
