const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "http://localhost:4200",
        methods: ["GET", "POST"]
    }
});

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'par_bajnoksag'
});

// Memóriában tárolt adatok a szobákhoz
const roomLevels = {};
const rooms = {};

io.on('connection', (socket) => {
    console.log('Új kliens kapcsolódott:', socket.id);

    // --- SZOBÁHOZ CSATLAKOZÁS ÉS LOBBY ---
    socket.on('join_room', (data) => {
        const { roomCode } = data;
        if (!roomCode) return;

        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [] };
        }

        // Ellenőrizzük, hogy a játékos már benne van-e, ha nincs, hozzáadjuk
        if (!rooms[roomCode].players.includes(socket.id)) {
            // Maximum 2 játékos per szoba
            if (rooms[roomCode].players.length >= 2) {
                socket.emit('game_over', { message: "A szoba megtelt!" });
                return;
            }
            rooms[roomCode].players.push(socket.id);
        }

        // SZEREP KIOSZTÁSA: Index alapján (0. = pilot, 1. = navigator)
        // Ez garantálja, hogy nem lesz két navigátor egy időben
        const playerIndex = rooms[roomCode].players.indexOf(socket.id);
        let assignedRole = (playerIndex === 0) ? 'pilot' : 'navigator';

        socket.emit('role_assigned', { role: assignedRole });
        console.log(`Szoba: ${roomCode} | ID: ${socket.id} | Szerep: ${assignedRole}`);

        // START: Csak ha megvan a két játékos
        if (rooms[roomCode].players.length === 2) {
            console.log(`Játék indítása a(z) ${roomCode} szobában.`);
            io.to(roomCode).emit('start_game');
            
            // Kezdő pálya lekérése (vagy ahol épp tartanak)
            const currentLevel = roomLevels[roomCode] || 1;
            db.query('SELECT map_data FROM maps WHERE id = ?', [currentLevel], (err, results) => {
                if (!err && results.length > 0) {
                    io.to(roomCode).emit('init_map', { map: JSON.parse(results[0].map_data) });
                }
            });
        }
    });

    // --- MOZGÁS SZINKRONIZÁLÁSA ---
    socket.on('player_move', (data) => {
        // Továbbítjuk a mozgást a szoba többi tagjának
        socket.to(data.roomCode).emit('update_position', { x: data.x, y: data.y });
    });

    // --- SZINTVÁLTÁS ---
    socket.on('level_complete', (data) => {
        const { roomCode } = data;

        roomLevels[roomCode] = (roomLevels[roomCode] || 1) + 1;
        const nextLevelId = roomLevels[roomCode];

        console.log(`--- SZINTVÁLTÁS --- Szoba: ${roomCode} -> Új szint: ${nextLevelId}`);

        db.query('SELECT map_data FROM maps WHERE id = ?', [nextLevelId], (err, results) => {
            if (err) {
                console.error("MySQL Hiba:", err);
                return;
            }

            if (results.length > 0) {
                try {
                    const nextMap = JSON.parse(results[0].map_data);
                    io.to(roomCode).emit('init_map', {
                        map: nextMap,
                        levelId: nextLevelId
                    });
                } catch (e) {
                    console.error("JSON parse hiba:", e);
                }
            } else {
                console.log(`Vége a játéknak a(z) ${roomCode} szobában.`);
                io.to(roomCode).emit('game_over', { message: "Gratulálunk! Minden szintet teljesítettetek!" });
            }
        });
    });

    // --- KILÉPÉS ÉS TAKARÍTÁS ---
    socket.on('disconnect', () => {
        console.log('Játékos lecsatlakozott:', socket.id);
        
        for (const roomCode in rooms) {
            const index = rooms[roomCode].players.indexOf(socket.id);
            if (index !== -1) {
                // Eltávolítjuk a listából
                rooms[roomCode].players.splice(index, 1);
                console.log(`Eltávolítva a(z) ${roomCode} szobából.`);

                // Ha kiürült a szoba, töröljük a memóriából
                if (rooms[roomCode].players.length === 0) {
                    delete rooms[roomCode];
                    delete roomLevels[roomCode];
                    console.log(`Szoba lezárva: ${roomCode}`);
                } else {
                    // Opcionális: Ha valaki kilép, a bentmaradót értesíthetjük
                    io.to(roomCode).emit('player_left', { message: "A partner kilépett a játékból." });
                }
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Szerver fut a 3000-es porton');
});