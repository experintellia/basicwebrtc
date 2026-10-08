//@ts-check

//------------------------------
// BASIC WEBRTC SIGNALING SERVER
//------------------------------

//Define https & websocket Port
const HTTP_PORT = parseInt(process.env.listen_port) > 0 ? parseInt(process.env.listen_port) : 3001;
const HTTP_IP = process.env.listen_ip ? process.env.listen_ip : "0.0.0.0";

//Define API Version
const API_VERSION = 1.4;

//Get dummy cert files for https
var fs = require('fs');

//SpinUP Webserver with socketIO
var express = require('express');
var handler = express();

handler.use(express.static(__dirname + '/web', {
    setHeaders: function (res, path) {
        res.append('Access-Control-Allow-Origin', ['*']);
        res.append('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
        res.append('Access-Control-Allow-Headers', 'Content-Type');
    }
}));

var app = require('http').createServer(handler)

var ioServer = require('socket.io')(app, {
    cors: {
        origin: function (origin, callback) {
            callback(null, true) // allow all origins
        },
        credentials: false,
        methods: ["GET", "POST"]
    }
});
var crypto = require('crypto');

app.listen(HTTP_PORT, HTTP_IP);

// iceservers.json holds the TURN secret and is not in git; fall back to public STUN only.
var iceFile = process.env.ICESERVERS_FILE || __dirname + "/iceservers.json";
if (!fs.existsSync(iceFile)) {
    console.warn("WARNING: no " + iceFile + ", using public STUN only (no TURN fallback)");
    iceFile = __dirname + "/iceservers.example.json";
}
var icesevers = JSON.parse(fs.readFileSync(iceFile, 'utf8'));

console.log("--------------------------------------------");
console.log("SIGNALINGSERVER RUNNING ON IP:PORT: " + HTTP_IP + ':' + HTTP_PORT);
console.log("--------------------------------------------");

var registerdUUIDs = Object.create(null); // no prototype: "__proto__" etc. are plain keys
var socketID_UUIDMatch = Object.create(null);
// Closed rooms, while they have members: any member locks, newcomers knock, any member admits or rejects.
// ponytail: the reject cooldown is keyed by the knocker's per-tab id, so it slows down honest retries, not a determined knocker.
var rooms = Object.create(null);
const ROOM_GRACE_MS = parseInt(process.env.ROOM_GRACE_MS) || 15000; // an emptied room keeps its lock this long: a reload or reconnect is no way in
const str = v => typeof v == "string" ? v : ""; // String() of an object can throw and kill the server
const roomState = name => rooms[name] ||= { locked: false, approved: new Set(), knocks: new Map(), rejects: new Map() };
function forgetRoom(name) { // no member for a while: open again, knockers still waiting are sent in
    for (const k of rooms[name]?.knocks.values() || []) ioServer.to(k.socketId).emit("knockAnswer", { accept: true });
    delete rooms[name];
}

//Listen for IO connections and do signaling
ioServer.sockets.on('connection', function (socket) {
    socket.emit('API_VERSION', API_VERSION);

    let roomOfUser = null;
    let knockRoom = null; // room this socket knocks at
    let MY_UUID = null;
    console.log("NEW USER!");

    socket.on("registerUUID", function (content, callback) {
        if (typeof callback != "function") return;
        const UUID = content && content["UUID"];
        const UUID_KEY = content && content["UUID_KEY"];
        if (typeof UUID != "string" || !/^[\w-]{1,64}$/.test(UUID) || typeof UUID_KEY != "string" || !UUID_KEY) {
            return callback("UUID or UUID_KEY invalid on registerUUID!");
        }
        if (MY_UUID && MY_UUID != UUID) return callback("Only one UUID per connection!");
        if (!registerdUUIDs[UUID] || registerdUUIDs[UUID] === UUID_KEY) {
            const alreadyRegistred = registerdUUIDs[UUID] === UUID_KEY;
            registerdUUIDs[UUID] = UUID_KEY;
            socketID_UUIDMatch[UUID] = socket.id;
            MY_UUID = socket.data.uuid = UUID;
            callback(null, alreadyRegistred);
        } else {
            callback("UUID_KEY was not correct!")
        }
    });

    socket.on('disconnect', function () {
        const knocked = knockRoom !== null && rooms[knockRoom];
        if (knocked && knocked.knocks.get(MY_UUID)?.socketId === socket.id) {
            knocked.knocks.delete(MY_UUID);
            ioServer.to(knockRoom).emit("knockDone", MY_UUID);
        }
        const name = roomOfUser;
        if (name !== null && !ioServer.sockets.adapter.rooms.get(name)) {
            setTimeout(() => ioServer.sockets.adapter.rooms.get(name) || forgetRoom(name), ROOM_GRACE_MS);
        }
        if (socketID_UUIDMatch[MY_UUID] !== socket.id) return; // a newer socket already took over this UUID
        socket.to(roomOfUser).emit('userDiscconected', MY_UUID);
        delete registerdUUIDs[MY_UUID];
        delete socketID_UUIDMatch[MY_UUID];
    });

    socket.on("joinRoom", function (content, callback) {
        if (!MY_UUID || !content || typeof content != "object" || roomOfUser !== null) return; // registered first, one room per connection
        const ack = typeof callback == "function" ? callback : () => { };
        const name = str(content["roomname"]).slice(0, 64);
        if (knockRoom !== null && knockRoom !== name) return;
        const room = roomState(name);
        // knockId: random per browser tab, only the server sees it. Approves a member's reload, keys a knocker's cooldown.
        const knockId = /^[\w-]{1,64}$/.test(str(content["knockId"])) ? content["knockId"] : MY_UUID;
        if (room.locked && !room.approved.has(MY_UUID) && !room.approved.has(knockId)) { // knock: members decide
            const wait = Math.ceil(((room.rejects.get(knockId)?.until || 0) - Date.now()) / 1000);
            if (wait > 0) return ack({ wait });
            knockRoom = name;
            const again = room.knocks.get(MY_UUID);
            if (again) return again.socketId = socket.id, ack({ wait: 0 }); // members see each knocker once
            if (room.knocks.size >= 5) return ack({ wait: 15 }); // door full: no flood of requests
            room.knocks.set(MY_UUID, { socketId: socket.id, name: str(content["name"]).slice(0, 64), knockId });
            ioServer.to(name).emit("knock", { UUID: MY_UUID, name: room.knocks.get(MY_UUID).name });
            return ack({ wait: 0 });
        }
        room.approved.add(MY_UUID).add(knockId); // also when it reconnects or reloads later
        roomOfUser = socket.data.room = name;
        const keep = Array.isArray(content["keep"]) ? content["keep"].filter(k => typeof k == "string").slice(0, 8) : []; // peers a rejoining page still has a live call with
        socket.to(roomOfUser).emit('userJoined', { UUID: MY_UUID, keep });
        const members = [...(ioServer.sockets.adapter.rooms.get(roomOfUser) || [])].map(id => ioServer.sockets.sockets.get(id)?.data.uuid);
        ack(members); // who is in the room, so a rejoining page can resync
        console.log("joinRoom", roomOfUser, MY_UUID);
        socket.join(roomOfUser);
        if (room.locked) socket.emit("locked", { locked: true });
        for (const [UUID, k] of room.knocks) socket.emit("knock", { UUID, name: k.name });
    })

    socket.on("setLocked", function (locked, name) { // name: peers may not have it over P2P yet
        if (roomOfUser === null || typeof locked != "boolean") return; // members only
        const room = roomState(roomOfUser);
        room.locked = locked;
        ioServer.to(roomOfUser).emit("locked", { locked, by: MY_UUID, name: str(name).slice(0, 64) });
        if (locked) return;
        for (const [UUID, k] of room.knocks) { // open again: nobody waits at the door
            ioServer.to(k.socketId).emit("knockAnswer", { accept: true });
            ioServer.to(roomOfUser).emit("knockDone", UUID);
        }
        room.knocks.clear();
    });

    socket.on("answerKnock", function (content) {
        const room = roomOfUser !== null && rooms[roomOfUser]; // members only
        const k = room && content && room.knocks.get(content.UUID);
        if (!k) return;
        room.knocks.delete(content.UUID);
        ioServer.to(roomOfUser).emit("knockDone", content.UUID);
        if (content.accept === true) {
            room.approved.add(content.UUID).add(k.knockId);
            return ioServer.to(k.socketId).emit("knockAnswer", { accept: true });
        }
        const r = room.rejects.get(k.knockId) || { count: 0 };
        const wait = Math.min(15 * 2 ** r.count++, 600); // 15s, 30s, 60s ... 10min
        room.rejects.set(k.knockId, { count: r.count, until: Date.now() + wait * 1000 });
        ioServer.to(k.socketId).emit("knockAnswer", { wait });
    });

    socket.on("signaling", function (content) {
        if (!content || typeof content != "object" || roomOfUser === null) return;
        var destSocketId = socketID_UUIDMatch[content.destUUID];
        var signalingData = content.signalingData;
        if (ioServer.sockets.sockets.get(destSocketId)?.data.room !== roomOfUser) return; // same room only

        ioServer.to(destSocketId).emit('signaling', { signalingData: signalingData, fromUUID: MY_UUID }); // chat, names etc. go peer-to-peer
    });

    //Return the current iceServers
    var returnIce = [];
    for (var i in icesevers) {
        if (icesevers[i].turnServerCredential) { //Generate a temp user and password with this turn server creds if given
            var turnCredentials = getTURNCredentials(icesevers[i].username, icesevers[i].turnServerCredential);
            returnIce.push({
                urls: icesevers[i].urls || icesevers[i].url,
                credential: turnCredentials.password,
                username: turnCredentials.username,
            });
        } else {
            returnIce.push({ urls: icesevers[i].urls || icesevers[i].url });
        }
    }
    socket.emit('currentIceServers', returnIce);
})

function getTURNCredentials(name, secret) {
    var unixTimeStamp = parseInt((Date.now() / 1000) + "") + 12 * 3600,   // this credential would be valid for the next 12 hours
        username = [unixTimeStamp, name].join(':'),
        password,
        hmac = crypto.createHmac('sha1', secret);
    hmac.setEncoding('base64');
    hmac.write(username);
    hmac.end();
    password = hmac.read();
    return {
        username: username,
        password: password
    };
}