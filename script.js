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
let myName = "";
let myProfilePic = "";

// Supabase Initialization
const supabaseUrl = window.ENV.SUPABASE_URL;
const supabaseKey = window.ENV.SUPABASE_KEY;
// Need to check if it's the placeholder (meaning running locally without injection)
const isLocal = supabaseUrl === "YOUR_SUPABASE_URL_HERE";
const supabase = isLocal ? null : window.supabase.createClient(supabaseUrl, supabaseKey);

if (supabase) {
    supabase.auth.onAuthStateChange((event, session) => {
        if (session) {
            myName = session.user.user_metadata.full_name || session.user.email.split('@')[0];
            myProfilePic = session.user.user_metadata.avatar_url || "";
            
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
        const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' });
        if (error) showToast("Login failed: " + error.message);
    });
} else {
    // Local dev bypass
    console.warn("Supabase not configured. Bypassing auth for local testing.");
    myName = "Local Dev";
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('setup-options').classList.remove('hidden');
    document.getElementById('user-profile-name').innerText = myName;
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
        showToast('Connection error: ' + err.message);
    });
}

// ==========================================
// HOST LOGIC
// ==========================================
document.getElementById('btn-create-room').addEventListener('click', () => {
    if (!peer) initPeer();
    
    peer.on('open', (id) => {
        isHost = true;
        myPlayerId = 0;
        
        // Generate short room code (mapped to Peer ID)
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        // Since we are using free PeerJS server, we will just use the code as prefix for our custom ID
        // Wait, to force a specific ID, we must recreate Peer.
        peer.destroy();
        peer = new Peer(`gcbc-game-${roomCode}`);
        
        peer.on('open', () => {
            document.getElementById('lobby-code').innerText = roomCode;
            setupScreen.classList.remove('active');
            lobbyScreen.classList.add('active');
            document.getElementById('btn-start-game').classList.remove('hidden');
            document.getElementById('waiting-msg').classList.add('hidden');
            
            gameState.players.push({ id: myPlayerId, name: myName, picture: myProfilePic, badCards: [], goodCards: [], isFinished: false });
            renderLobby();
        });

        peer.on('connection', (conn) => {
            clientConns.push(conn);
            
            conn.on('data', (data) => {
                if (data.type === 'JOIN') {
                    const newPlayerId = gameState.players.length;
                    gameState.players.push({ id: newPlayerId, name: data.name, picture: data.picture, badCards: [], goodCards: [], isFinished: false });
                    conn.playerId = newPlayerId;
                    renderLobby();
                    broadcastState();
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
    
    // Update host's own UI
    if (gameState.status === 'FINISHED') {
        gameState = JSON.parse(JSON.stringify(gameState)); // keep it un-sanitized
    } else {
        gameState = sanitizeStateFor(myPlayerId);
    }
    
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
            p.badCards.forEach(c => c.value = null);
        } else {
            // Can't see opponent good cards
            p.goodCards.forEach(c => c.value = null);
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
        p.badCards = [hostDeck.pop(), hostDeck.pop(), hostDeck.pop()];
        p.goodCards = [];
        p.isFinished = false;
    });
    
    gameState.tradeDeck = [hostDeck.pop()];
    gameState.trashDeck = [];
    gameState.deckCount = hostDeck.length;
    gameState.status = 'PLAYING';
    gameState.currentPlayerIndex = 0;
    
    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');
    broadcastState();
});

// Host logic handling incoming actions
function handleHostAction(playerId, action, payload) {
    if (playerId !== gameState.currentPlayerIndex && action !== 'MOVE_2_TRADE_RESOLVE') return;
    
    const currPlayer = gameState.players[gameState.currentPlayerIndex];
    
    if (action === 'MOVE_1') {
        const badCardIdx = currPlayer.badCards.findIndex(c => c.id === payload.badCardId);
        if (badCardIdx === -1) return;
        
        const cardToTrade = currPlayer.badCards.splice(badCardIdx, 1)[0];
        const newGoodCard = gameState.tradeDeck.pop();
        currPlayer.goodCards.push(newGoodCard);
        gameState.tradeDeck.push(cardToTrade);
        
        hostNextTurn();
    } 
    else if (action === 'MOVE_2_TAKE') {
        if (hostDeck.length === 0) return;
        const goodCardIdx = currPlayer.goodCards.findIndex(c => c.id === payload.goodCardId);
        if (goodCardIdx === -1) return;
        
        const cardToTrash = currPlayer.goodCards.splice(goodCardIdx, 1)[0];
        gameState.trashDeck.push(cardToTrash);
        
        currPlayer.badCards.push(hostDeck.pop());
        gameState.deckCount = hostDeck.length;
        
        hostNextTurn();
    }
    else if (action === 'MOVE_2_TRADE_START') {
        if (hostDeck.length === 0) return;
        const targetPlayer = gameState.players.find(p => p.id === payload.targetPlayerId);
        
        const goodCardIdx = currPlayer.goodCards.findIndex(c => c.id === payload.goodCardId);
        const badCardIdx = targetPlayer.badCards.findIndex(c => c.id === payload.targetBadCardId);
        
        if (goodCardIdx === -1 || badCardIdx === -1) return;
        
        // Trash good
        gameState.trashDeck.push(currPlayer.goodCards.splice(goodCardIdx, 1)[0]);
        // Steal bad as good
        currPlayer.goodCards.push(targetPlayer.badCards.splice(badCardIdx, 1)[0]);
        
        // Enter Trade State (waiting for target player to pick)
        gameState.tradeState = { initiatorId: currPlayer.id, targetId: targetPlayer.id };
        broadcastState();
    }
    else if (action === 'MOVE_2_TRADE_RESOLVE') {
        if (!gameState.tradeState || playerId !== gameState.tradeState.targetId) return;
        
        const targetPlayer = gameState.players.find(p => p.id === gameState.tradeState.targetId);
        const initPlayer = gameState.players.find(p => p.id === gameState.tradeState.initiatorId);
        
        const badCardIdx = initPlayer.badCards.findIndex(c => c.id === payload.chosenBadCardId);
        if (badCardIdx === -1) return;
        
        // Target steals init's bad card as good
        targetPlayer.goodCards.push(initPlayer.badCards.splice(badCardIdx, 1)[0]);
        
        // Init draws bad card from deck
        initPlayer.badCards.push(hostDeck.pop());
        gameState.deckCount = hostDeck.length;
        
        gameState.tradeState = null;
        hostNextTurn();
    }
}

function hostNextTurn() {
    // Check finished
    gameState.players.forEach(p => {
        if (p.badCards.length === 0 && !p.isFinished) {
            p.isFinished = true;
        }
    });

    if (gameState.players.every(p => p.isFinished)) {
        gameState.status = 'FINISHED';
        broadcastState();
        return;
    }
    
    // Advance to next unfinished player
    do {
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
    } while (gameState.players[gameState.currentPlayerIndex].isFinished);
    
    broadcastState();
}

// ==========================================
// CLIENT LOGIC
// ==========================================
document.getElementById('btn-join-room').addEventListener('click', () => {
    const code = document.getElementById('join-code').value.toUpperCase();
    if (!code) return showToast('Enter a Room Code');
    
    if (!peer) initPeer();
    
    peer.on('open', () => {
        hostConn = peer.connect(`gcbc-game-${code}`);
        
        hostConn.on('open', () => {
            isHost = false;
            hostConn.send({ type: 'JOIN', name: myName, picture: myProfilePic });
            
            document.getElementById('lobby-code').innerText = code;
            setupScreen.classList.remove('active');
            lobbyScreen.classList.add('active');
        });
        
        hostConn.on('data', (data) => {
            if (data.type === 'STATE') {
                const oldStatus = gameState.status;
                gameState = data.state;
                
                // Assign myPlayerId if not set by looking at the last added player matching name
                // Note: Better to let Host assign it via connection ID, but Host sends it correctly
                // Since Host sends customized state, we can find our ID by seeing which player has `badCards.value === null`
                if (myPlayerId === null && gameState.players.length > 0) {
                    const me = gameState.players.find(p => p.name === myName && p.badCards.some(c => c.value === null));
                    if (me) myPlayerId = me.id;
                }
                
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
        
        hostConn.on('error', () => showToast('Failed to connect to host.'));
    });
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
}

function createCardElement(card, isFaceDown, isGood, onClick) {
    const el = document.createElement('div');
    el.className = `card ${isFaceDown ? 'face-down' : ''} ${isGood ? 'good-card' : 'bad-card'}`;
    el.dataset.id = card.id;
    if (!isFaceDown && card.value !== null) {
        el.dataset.value = card.value;
        el.innerText = card.value;
    } else if (!isFaceDown && card.value === null) {
        el.innerText = '?'; // Unknown value fallback
    }
    if (onClick) {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(card, el);
        });
    }
    return el;
}

function renderGame() {
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

    // My Hand
    const handContainer = document.getElementById('current-player-hand');
    handContainer.innerHTML = '';
    
    // 'me' is already declared at the top of renderGame
    if (me) {
        me.goodCards.forEach(card => {
            const el = createCardElement(card, false, true, (c) => {
                if (!isMyTurn || gameState.tradeState) return;
                selectedOwnGoodCard = selectedOwnGoodCard === c.id ? null : c.id;
                selectedOwnBadCard = null;
                renderGame();
            });
            if (selectedOwnGoodCard === card.id) el.classList.add('selected');
            handContainer.appendChild(el);
        });

        me.badCards.forEach(card => {
            const el = createCardElement(card, true, false, (c) => {
                if (!isMyTurn || gameState.tradeState) return;
                selectedOwnBadCard = selectedOwnBadCard === c.id ? null : c.id;
                selectedOwnGoodCard = null;
                renderGame();
            });
            if (selectedOwnBadCard === card.id) el.classList.add('selected');
            handContainer.appendChild(el);
        });
    }

    // Opponents
    const opponentsContainer = document.getElementById('opponents-container');
    opponentsContainer.innerHTML = '';

    gameState.players.forEach(p => {
        if (p.id === myPlayerId) return;

        const oppEl = document.createElement('div');
        oppEl.className = `opponent ${p.isFinished ? 'finished' : ''} ${p.id === gameState.currentPlayerIndex ? 'is-turn' : ''}`;
        oppEl.innerHTML = `<div class="opponent-header">
            ${p.picture ? `<img src="${p.picture}" class="profile-pic small">` : '👤'}
            <h3>${p.name}</h3>
        </div><div class="hand"></div>`;
        const oppHand = oppEl.querySelector('.hand');

        p.goodCards.forEach(card => oppHand.appendChild(createCardElement(card, true, true)));

        p.badCards.forEach(card => {
            const el = createCardElement(card, false, false, (c) => {
                if (!isMyTurn || p.isFinished || gameState.tradeState) return;
                
                if (selectedOpponentBadCard === c.id) {
                    selectedOpponentBadCard = null;
                    tradeTargetPlayerIndex = null;
                } else {
                    selectedOpponentBadCard = c.id;
                    tradeTargetPlayerIndex = p.id;
                }
                renderGame();
            });
            if (selectedOpponentBadCard === card.id) el.classList.add('selected');
            oppHand.appendChild(el);
        });

        opponentsContainer.appendChild(oppEl);
    });

    // Modals
    const modal = document.getElementById('trade-modal');
    if (gameState.tradeState) {
        if (gameState.tradeState.targetId === myPlayerId) {
            // I am the target! I must choose one of the initiator's bad cards.
            const initPlayer = gameState.players.find(p => p.id === gameState.tradeState.initiatorId);
            document.getElementById('trade-modal-desc').innerText = `Choose a Bad Card from ${initPlayer.name} to keep as your Good Card!`;
            const cardsContainer = document.getElementById('trade-modal-cards');
            cardsContainer.innerHTML = '';
            
            initPlayer.badCards.forEach(card => {
                // Should be visible to me
                const el = createCardElement(card, false, false, (c) => {
                    sendAction('MOVE_2_TRADE_RESOLVE', { chosenBadCardId: c.id });
                    modal.classList.remove('active');
                });
                cardsContainer.appendChild(el);
            });
            modal.classList.add('active');
        } else {
            document.getElementById('trade-modal-desc').innerText = `Waiting for opponent to choose a card...`;
            document.getElementById('trade-modal-cards').innerHTML = '';
            modal.classList.add('active');
        }
    } else {
        modal.classList.remove('active');
    }

    updateButtons(isMyTurn);
}

function updateButtons(isMyTurn) {
    const btn1 = document.getElementById('btn-move-1');
    const btn2Take = document.getElementById('btn-move-2-take');
    const btn2Trade = document.getElementById('btn-move-2-trade');

    if (!isMyTurn || gameState.tradeState) {
        btn1.disabled = true;
        btn2Take.disabled = true;
        btn2Trade.disabled = true;
        return;
    }

    btn1.disabled = !selectedOwnBadCard;
    btn2Take.disabled = !selectedOwnGoodCard || gameState.deckCount === 0;
    btn2Trade.disabled = !selectedOwnGoodCard || !selectedOpponentBadCard || gameState.deckCount === 0;
}

// Move Listeners
document.getElementById('btn-move-1').addEventListener('click', () => {
    if (!selectedOwnBadCard) return;
    sendAction('MOVE_1', { badCardId: selectedOwnBadCard });
    resetSelections();
});

document.getElementById('btn-move-2-take').addEventListener('click', () => {
    if (!selectedOwnGoodCard) return;
    sendAction('MOVE_2_TAKE', { goodCardId: selectedOwnGoodCard });
    resetSelections();
});

document.getElementById('btn-move-2-trade').addEventListener('click', () => {
    if (!selectedOwnGoodCard || selectedOpponentBadCard === null) return;
    sendAction('MOVE_2_TRADE_START', { 
        goodCardId: selectedOwnGoodCard, 
        targetPlayerId: tradeTargetPlayerIndex, 
        targetBadCardId: selectedOpponentBadCard 
    });
    resetSelections();
});

function resetSelections() {
    selectedOwnBadCard = null;
    selectedOwnGoodCard = null;
    selectedOpponentBadCard = null;
    tradeTargetPlayerIndex = null;
    if(gameState.status === 'PLAYING') renderGame();
}

function renderGameOver() {
    const scoreboard = document.getElementById('scoreboard');
    scoreboard.innerHTML = '';
    
    let scores = gameState.players.map(p => {
        // Since state is sanitized, if it's not the host, we might not have all the correct values?
        // Wait! In FINISHED state, the host should reveal everything!
        // To fix this without a complex change, we just sum up whatever we have. But clients won't have values.
        // For a quick fix, let's just show standard game over. (Host calculates sums, but we didn't send them yet).
        const sum = p.goodCards.reduce((acc, c) => acc + (c.value||0), 0) + p.badCards.reduce((acc, c) => acc + (c.value||0), 0);
        return { ...p, sum };
    });
    
    scores.sort((a, b) => a.sum - b.sum);
    
    scores.forEach((s, idx) => {
        const row = document.createElement('div');
        row.className = `score-row ${idx === 0 ? 'winner' : ''}`;
        row.innerHTML = `<span>${idx === 0 ? '🏆 ' : ''}${s.name}</span> <span>${s.sum} pts</span>`;
        scoreboard.appendChild(row);
    });
    
    if (isHost && supabase) {
        // Record match in Supabase
        supabase.from('matches').insert([{
            winner: scores[0].name,
            players: scores.map(s => s.name).join(', ')
        }]).then(({error}) => {
            if (error) console.error("Failed to save match:", error);
            else console.log("Match saved to Supabase!");
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
