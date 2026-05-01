const CARD_COUNTS = {
    0: 4, 1: 6, 2: 10, 3: 10, 4: 10, 5: 10,
    6: 12, 7: 12, 8: 12, 9: 15, 10: 15
};

let deck = [];
let players = [];
let currentPlayerIndex = 0;
let tradeDeck = [];
let trashDeck = [];
let numPlayers = 3;

// Selection State
let selectedOwnBadCard = null;
let selectedOwnGoodCard = null;
let selectedOpponentBadCard = null;
let tradeTargetPlayerIndex = null;

// DOM Elements
const setupScreen = document.getElementById('setup-screen');
const transitionScreen = document.getElementById('turn-transition-screen');
const gameScreen = document.getElementById('game-screen');
const gameOverScreen = document.getElementById('game-over-screen');

function initDeck() {
    deck = [];
    let idCounter = 0;
    for (const [val, count] of Object.entries(CARD_COUNTS)) {
        for (let i = 0; i < count; i++) {
            deck.push({ id: idCounter++, value: parseInt(val) });
        }
    }
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function startGame() {
    initDeck();
    players = [];
    for (let i = 0; i < numPlayers; i++) {
        players.push({
            id: i,
            name: `Player ${i + 1}`,
            badCards: [deck.pop(), deck.pop(), deck.pop()],
            goodCards: [],
            isFinished: false
        });
    }
    tradeDeck = [deck.pop()];
    trashDeck = [];
    currentPlayerIndex = 0;
    
    setupScreen.classList.remove('active');
    showTransitionScreen();
}

function showTransitionScreen() {
    // Skip finished players
    let startIdx = currentPlayerIndex;
    while (players[currentPlayerIndex].isFinished) {
        currentPlayerIndex = (currentPlayerIndex + 1) % numPlayers;
        if (currentPlayerIndex === startIdx) {
            endGame();
            return;
        }
    }

    gameScreen.classList.remove('active');
    document.getElementById('next-player-name').innerText = `${players[currentPlayerIndex].name}'s Turn`;
    document.getElementById('next-player-name-span').innerText = players[currentPlayerIndex].name;
    transitionScreen.classList.add('active');
}

document.getElementById('ready-btn').addEventListener('click', () => {
    transitionScreen.classList.remove('active');
    resetSelections();
    renderGame();
    gameScreen.classList.add('active');
});

function resetSelections() {
    selectedOwnBadCard = null;
    selectedOwnGoodCard = null;
    selectedOpponentBadCard = null;
    tradeTargetPlayerIndex = null;
}

function createCardElement(card, isFaceDown, isGood, onClick) {
    const el = document.createElement('div');
    el.className = `card ${isFaceDown ? 'face-down' : ''} ${isGood ? 'good-card' : 'bad-card'}`;
    el.dataset.id = card.id;
    if (!isFaceDown) {
        el.dataset.value = card.value;
        el.innerText = card.value;
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
    document.getElementById('bad-deck-count').innerText = deck.length;
    
    const tradeSlot = document.querySelector('#trade-deck .card-slot');
    tradeSlot.innerHTML = '';
    if (tradeDeck.length > 0) {
        tradeSlot.appendChild(createCardElement(tradeDeck[tradeDeck.length - 1], true, false));
    } else {
        tradeSlot.classList.add('empty');
    }

    const trashSlot = document.querySelector('#trash-deck .card-slot');
    trashSlot.innerHTML = '';
    if (trashDeck.length > 0) {
        trashSlot.appendChild(createCardElement(trashDeck[trashDeck.length - 1], false, false));
        trashSlot.classList.remove('empty');
    } else {
        trashSlot.classList.add('empty');
    }

    const currPlayer = players[currentPlayerIndex];
    document.getElementById('current-player-name').innerText = `${currPlayer.name}'s Hand`;

    const handContainer = document.getElementById('current-player-hand');
    handContainer.innerHTML = '';

    // Current player good cards (Face Up)
    currPlayer.goodCards.forEach(card => {
        const el = createCardElement(card, false, true, (c, element) => {
            if (selectedOwnGoodCard === c) {
                selectedOwnGoodCard = null;
            } else {
                selectedOwnGoodCard = c;
                selectedOwnBadCard = null; // mutually exclusive
            }
            renderGame();
        });
        if (selectedOwnGoodCard === card) el.classList.add('selected');
        handContainer.appendChild(el);
    });

    // Current player bad cards (Face Down)
    currPlayer.badCards.forEach(card => {
        const el = createCardElement(card, true, false, (c, element) => {
            if (selectedOwnBadCard === c) {
                selectedOwnBadCard = null;
            } else {
                selectedOwnBadCard = c;
                selectedOwnGoodCard = null;
            }
            renderGame();
        });
        if (selectedOwnBadCard === card) el.classList.add('selected');
        handContainer.appendChild(el);
    });

    const opponentsContainer = document.getElementById('opponents-container');
    opponentsContainer.innerHTML = '';

    players.forEach((p, idx) => {
        if (idx === currentPlayerIndex) return;

        const oppEl = document.createElement('div');
        oppEl.className = `opponent ${p.isFinished ? 'finished' : ''}`;
        oppEl.innerHTML = `<h3>${p.name}</h3><div class="hand"></div>`;
        const oppHand = oppEl.querySelector('.hand');

        // Opponent good cards (Face Down)
        p.goodCards.forEach(card => {
            oppHand.appendChild(createCardElement(card, true, true));
        });

        // Opponent bad cards (Face Up)
        p.badCards.forEach(card => {
            const el = createCardElement(card, false, false, (c, element) => {
                if (p.isFinished) {
                    showToast('Cannot target finished player!');
                    return;
                }
                if (selectedOpponentBadCard === c) {
                    selectedOpponentBadCard = null;
                    tradeTargetPlayerIndex = null;
                } else {
                    selectedOpponentBadCard = c;
                    tradeTargetPlayerIndex = idx;
                }
                renderGame();
            });
            if (selectedOpponentBadCard === card) el.classList.add('selected');
            oppHand.appendChild(el);
        });

        opponentsContainer.appendChild(oppEl);
    });

    updateButtons();
}

function updateButtons() {
    const btn1 = document.getElementById('btn-move-1');
    const btn2Take = document.getElementById('btn-move-2-take');
    const btn2Trade = document.getElementById('btn-move-2-trade');

    btn1.disabled = !selectedOwnBadCard;
    btn2Take.disabled = !selectedOwnGoodCard || deck.length === 0;
    btn2Trade.disabled = !selectedOwnGoodCard || !selectedOpponentBadCard || deck.length === 0;
}

function nextTurn() {
    players.forEach(p => {
        if (p.badCards.length === 0 && !p.isFinished) {
            p.isFinished = true;
            showToast(`${p.name} is Finished!`);
        }
    });

    const allFinished = players.every(p => p.isFinished);
    if (allFinished) {
        setTimeout(endGame, 1500);
        return;
    }
    currentPlayerIndex = (currentPlayerIndex + 1) % numPlayers;
    showTransitionScreen();
}

// Moves
document.getElementById('btn-move-1').addEventListener('click', () => {
    if (!selectedOwnBadCard) return;
    const currPlayer = players[currentPlayerIndex];
    
    // Remove selected from bad cards
    currPlayer.badCards = currPlayer.badCards.filter(c => c !== selectedOwnBadCard);
    
    // Take from trade deck
    const newGoodCard = tradeDeck.pop();
    currPlayer.goodCards.push(newGoodCard);
    
    // Put selected onto trade deck
    tradeDeck.push(selectedOwnBadCard);
    
    showToast('Move 1 completed!');
    nextTurn();
});

document.getElementById('btn-move-2-take').addEventListener('click', () => {
    if (!selectedOwnGoodCard || deck.length === 0) return;
    const currPlayer = players[currentPlayerIndex];
    
    // Sacrifice good card
    currPlayer.goodCards = currPlayer.goodCards.filter(c => c !== selectedOwnGoodCard);
    trashDeck.push(selectedOwnGoodCard);
    
    // Take bad card from deck
    const newBadCard = deck.pop();
    currPlayer.badCards.push(newBadCard);
    
    showToast('Move 2 (Take) completed!');
    nextTurn();
});

document.getElementById('btn-move-2-trade').addEventListener('click', () => {
    if (!selectedOwnGoodCard || !selectedOpponentBadCard || deck.length === 0) return;
    
    const currPlayer = players[currentPlayerIndex];
    const targetPlayer = players[tradeTargetPlayerIndex];
    
    // Current player sacrifices good card
    currPlayer.goodCards = currPlayer.goodCards.filter(c => c !== selectedOwnGoodCard);
    trashDeck.push(selectedOwnGoodCard);
    
    // Current player takes opponent's bad card as good card
    targetPlayer.badCards = targetPlayer.badCards.filter(c => c !== selectedOpponentBadCard);
    currPlayer.goodCards.push(selectedOpponentBadCard);
    
    // Show modal for opponent to pick one of current player's bad cards
    showTradeModal(currPlayer, targetPlayer);
});

function showTradeModal(currPlayer, targetPlayer) {
    const modal = document.getElementById('trade-modal');
    document.getElementById('trade-modal-desc').innerText = `${targetPlayer.name}, choose a Bad Card from ${currPlayer.name} to keep as your Good Card!`;
    
    const cardsContainer = document.getElementById('trade-modal-cards');
    cardsContainer.innerHTML = '';
    
    currPlayer.badCards.forEach(card => {
        // Face up for the opponent to see and pick
        const el = createCardElement(card, false, false, (c) => {
            // Opponent selected a card
            currPlayer.badCards = currPlayer.badCards.filter(rc => rc !== c);
            targetPlayer.goodCards.push(c);
            
            // Current player takes a bad card from bad deck
            const newBadCard = deck.pop();
            currPlayer.badCards.push(newBadCard);
            
            modal.classList.remove('active');
            showToast('Move 2 (Trade) completed!');
            nextTurn();
        });
        cardsContainer.appendChild(el);
    });
    
    modal.classList.add('active');
}

function endGame() {
    gameScreen.classList.remove('active');
    transitionScreen.classList.remove('active');
    setupScreen.classList.remove('active');
    
    const scoreboard = document.getElementById('scoreboard');
    scoreboard.innerHTML = '';
    
    let scores = players.map(p => {
        const sum = p.goodCards.reduce((acc, c) => acc + c.value, 0) + p.badCards.reduce((acc, c) => acc + c.value, 0);
        return { ...p, sum };
    });
    
    scores.sort((a, b) => a.sum - b.sum);
    
    scores.forEach((s, idx) => {
        const row = document.createElement('div');
        row.className = `score-row ${idx === 0 ? 'winner' : ''}`;
        row.innerHTML = `<span>${idx === 0 ? '🏆 ' : ''}${s.name}</span> <span>${s.sum} pts</span>`;
        scoreboard.appendChild(row);
    });
    
    gameOverScreen.classList.add('active');
}

document.getElementById('restart-btn').addEventListener('click', () => {
    gameOverScreen.classList.remove('active');
    setupScreen.classList.add('active');
});

// Setup logic
document.querySelectorAll('.player-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.player-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        numPlayers = parseInt(e.target.dataset.count);
    });
});

document.getElementById('start-btn').addEventListener('click', startGame);

function showToast(msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, 3000);
}
