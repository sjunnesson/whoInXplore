import type * as Party from "partykit/server";

interface PlayerData {
  name: string;
  avatar: string;
  statements: string[];
}

interface DeckCard {
  personIndex: number;
  text: string;
}

interface ConnectedPlayer {
  name: string;
  playerIndex: number | null; // index in gameData, null if unclaimed
}

interface GameState {
  phase: "lobby" | "playing" | "ended";
  hostId: string | null;
  gameData: PlayerData[];
  deck: DeckCard[];
  currentCardIndex: number;
  currentPlayerIndex: number;
  playerScores: number[];
  playerAttempts: number[];
  playerCorrect: number[];
  playerStreaks: number[];
  comboCount: number;
  totalCards: number;
}

export default class WhoInXplore implements Party.Server {
  state: GameState;
  players: Map<string, ConnectedPlayer>;

  constructor(readonly room: Party.Room) {
    this.players = new Map();
    this.state = {
      phase: "lobby",
      hostId: null,
      gameData: [],
      deck: [],
      currentCardIndex: 0,
      currentPlayerIndex: 0,
      playerScores: [],
      playerAttempts: [],
      playerCorrect: [],
      playerStreaks: [],
      comboCount: 0,
      totalCards: 0,
    };
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const name = url.searchParams.get("name") || "Player";

    this.players.set(conn.id, { name, playerIndex: null });

    // First player becomes host
    if (!this.state.hostId || !this.players.has(this.state.hostId)) {
      this.state.hostId = conn.id;
    }

    // If game is in progress, send full state to reconnecting player
    if (this.state.phase === "playing") {
      conn.send(JSON.stringify({
        type: "gameStarted",
        gameData: this.state.gameData,
        deck: this.state.deck,
        playerScores: this.state.playerScores,
        playerAttempts: this.state.playerAttempts,
        playerCorrect: this.state.playerCorrect,
        playerStreaks: this.state.playerStreaks,
        comboCount: this.state.comboCount,
        currentCardIndex: this.state.currentCardIndex,
        currentPlayerIndex: this.state.currentPlayerIndex,
        totalCards: this.state.totalCards,
        players: this.getPlayersInfo(),
        hostId: this.state.hostId,
        yourId: conn.id,
      }));
      return;
    }

    // Send lobby state to everyone
    this.broadcastLobby();
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case "setGameData":
        if (sender.id !== this.state.hostId) return;
        this.state.gameData = msg.gameData;
        this.broadcastLobby();
        break;

      case "claimCharacter":
        this.handleClaimCharacter(sender, msg.playerIndex);
        break;

      case "startGame":
        if (sender.id !== this.state.hostId) return;
        if (this.state.gameData.length < 2) return;
        this.startGame();
        break;

      case "guess":
        this.handleGuess(sender, msg.guessedPersonIndex);
        break;

      case "cursor":
        // Broadcast cursor position to everyone except sender
        this.room.broadcast(
          JSON.stringify({
            type: "cursor",
            id: sender.id,
            x: msg.x,
            y: msg.y,
            name: this.players.get(sender.id)?.name || "?",
          }),
          [sender.id]
        );
        break;

      case "restart":
        if (sender.id !== this.state.hostId) return;
        this.state.phase = "lobby";
        this.broadcastLobby();
        break;
    }
  }

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id);

    // Reassign host if host left
    if (conn.id === this.state.hostId) {
      const firstPlayer = this.players.keys().next().value;
      this.state.hostId = firstPlayer || null;
    }

    if (this.state.phase === "lobby") {
      this.broadcastLobby();
    }
  }

  handleClaimCharacter(sender: Party.Connection, playerIndex: number) {
    if (this.state.phase !== "lobby") return;
    if (playerIndex < 0 || playerIndex >= this.state.gameData.length) return;

    // Check if already claimed by someone else
    for (const [id, player] of this.players) {
      if (id !== sender.id && player.playerIndex === playerIndex) return;
    }

    const player = this.players.get(sender.id);
    if (player) {
      player.playerIndex = playerIndex;
      this.broadcastLobby();
    }
  }

  startGame() {
    // Build and shuffle deck
    const deck: DeckCard[] = [];
    this.state.gameData.forEach((person, pi) => {
      person.statements.forEach((text) => {
        deck.push({ personIndex: pi, text });
      });
    });
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    const numPlayers = this.state.gameData.length;
    this.state.deck = deck;
    this.state.totalCards = deck.length;
    this.state.currentCardIndex = 0;
    this.state.currentPlayerIndex = 0;
    this.state.playerScores = Array(numPlayers).fill(0);
    this.state.playerAttempts = Array(numPlayers).fill(0);
    this.state.playerCorrect = Array(numPlayers).fill(0);
    this.state.playerStreaks = Array(numPlayers).fill(0);
    this.state.comboCount = 0;
    this.state.phase = "playing";

    // Broadcast full state to all
    this.room.broadcast(JSON.stringify({
      type: "gameStarted",
      gameData: this.state.gameData,
      deck: this.state.deck,
      playerScores: this.state.playerScores,
      playerAttempts: this.state.playerAttempts,
      playerCorrect: this.state.playerCorrect,
      playerStreaks: this.state.playerStreaks,
      comboCount: this.state.comboCount,
      currentCardIndex: this.state.currentCardIndex,
      currentPlayerIndex: this.state.currentPlayerIndex,
      totalCards: this.state.totalCards,
      players: this.getPlayersInfo(),
      hostId: this.state.hostId,
    }));

    // Also send each player their own ID
    for (const conn of this.room.getConnections()) {
      conn.send(JSON.stringify({ type: "yourId", yourId: conn.id }));
    }
  }

  handleGuess(sender: Party.Connection, guessedPersonIndex: number) {
    if (this.state.phase !== "playing") return;
    if (this.state.currentCardIndex >= this.state.totalCards) return;

    // Validate it's this player's turn
    const senderPlayer = this.players.get(sender.id);
    if (!senderPlayer) return;
    if (senderPlayer.playerIndex !== this.state.currentPlayerIndex) return;

    const card = this.state.deck[this.state.currentCardIndex];
    const isCorrect = guessedPersonIndex === card.personIndex;
    const pi = this.state.currentPlayerIndex;

    this.state.playerAttempts[pi]++;

    let points = 0;
    let multiplier = 1;

    if (isCorrect) {
      this.state.comboCount++;
      this.state.playerStreaks[pi]++;

      const cc = this.state.comboCount;
      multiplier = cc <= 1 ? 1 : cc <= 2 ? 1.5 : cc <= 3 ? 2 : cc <= 5 ? 3 : 5;
      points = Math.round(10000 * multiplier);
      this.state.playerScores[pi] += points;
      this.state.playerCorrect[pi]++;
    } else {
      this.state.comboCount = 0;
      this.state.playerStreaks[pi] = 0;
    }

    // Advance
    this.state.currentCardIndex++;
    this.state.currentPlayerIndex =
      (this.state.currentPlayerIndex + 1) % this.state.gameData.length;

    const gameEnded = this.state.currentCardIndex >= this.state.totalCards;
    if (gameEnded) {
      this.state.phase = "ended";
    }

    // Broadcast guess result to all
    this.room.broadcast(JSON.stringify({
      type: "guessResult",
      guessedPersonIndex,
      correctPersonIndex: card.personIndex,
      isCorrect,
      guesserIndex: pi,
      points,
      multiplier,
      comboCount: this.state.comboCount,
      playerScores: [...this.state.playerScores],
      playerAttempts: [...this.state.playerAttempts],
      playerCorrect: [...this.state.playerCorrect],
      playerStreaks: [...this.state.playerStreaks],
      currentCardIndex: this.state.currentCardIndex,
      currentPlayerIndex: this.state.currentPlayerIndex,
      gameEnded,
    }));
  }

  getPlayersInfo() {
    const info: Record<string, { name: string; playerIndex: number | null }> = {};
    for (const [id, player] of this.players) {
      info[id] = { name: player.name, playerIndex: player.playerIndex };
    }
    return info;
  }

  broadcastLobby() {
    this.room.broadcast(JSON.stringify({
      type: "lobbyState",
      phase: this.state.phase,
      hostId: this.state.hostId,
      players: this.getPlayersInfo(),
      gameData: this.state.gameData,
    }));

    // Send each player their own ID
    for (const conn of this.room.getConnections()) {
      conn.send(JSON.stringify({ type: "yourId", yourId: conn.id }));
    }
  }
}
