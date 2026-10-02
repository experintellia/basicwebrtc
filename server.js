//@ts-check

//------------------------------
// BASIC WEBRTC SIGNALING SERVER
//------------------------------

//Define https & websocket Port
const HTTP_PORT = parseInt(process.env.listen_port) > 0 ? parseInt(process.env.listen_port) : 3001;
const HTTP_IP = process.env.listen_ip ? process.env.listen_ip : "0.0.0.0";

//Define API Version
const API_VERSION = 1.2;

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

var registerdUUIDs = {};
var socketID_UUIDMatch = {};

//Listen for IO connections and do signaling
ioServer.sockets.on('connection', function (socket) {
    socket.emit('API_VERSION', API_VERSION);

    let roomOfUser = null;
    let nameOfUser = "NA";
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
        if (!registerdUUIDs[UUID] || registerdUUIDs[UUID] == UUID_KEY) {
            const alreadyRegistred = registerdUUIDs[UUID] == UUID_KEY;
            registerdUUIDs[UUID] = UUID_KEY;
            socketID_UUIDMatch[UUID] = socket.id;
            MY_UUID = UUID;
            callback(null, alreadyRegistred);
        } else {
            callback("UUID_KEY was not correct!")
        }
    });

    socket.on('disconnect', function () {
        if (socketID_UUIDMatch[MY_UUID] !== socket.id) return; // a newer socket already took over this UUID
        socket.to(roomOfUser).emit('userDiscconected', MY_UUID);
        delete registerdUUIDs[MY_UUID];
        delete socketID_UUIDMatch[MY_UUID];
    });

    socket.on("joinRoom", function (content) {
        if (!MY_UUID || !content || typeof content != "object" || roomOfUser !== null) return; // registered first, one room per connection
        const str = v => typeof v == "string" ? v : ""; // String() of an object can throw and kill the server
        roomOfUser = socket.data.room = str(content["roomname"]).slice(0, 64);
        nameOfUser = str(content["username"]).slice(0, 64);
        socket.to(roomOfUser).emit('userJoined', { UUID: MY_UUID });
        console.log("joinRoom", roomOfUser, MY_UUID);
        socket.join(roomOfUser);
    })

    socket.on("setName", function (name) {
        if (typeof name != "string") return;
        nameOfUser = name.slice(0, 64);
        if (roomOfUser !== null) socket.to(roomOfUser).emit('userName', { fromUUID: MY_UUID, username: nameOfUser });
    });

    socket.on("sendMsg", function (msg) {
        if (typeof (msg) == "string") {
            if (msg != "") {
                if (nameOfUser != "" && nameOfUser != "NA") {
                    msg = nameOfUser + ': ' + msg;
                }
                socket.to(roomOfUser).emit('msg', msg);
                socket.emit('msg', msg);
            }
        }
    });

    socket.on("currentAudioLvl", function (currentAudioLvl) {
        socket.to(roomOfUser).emit('currentAudioLvl', { currentAudioLvl: currentAudioLvl, fromUUID: MY_UUID });
    });

    socket.on("signaling", function (content) {
        if (!content || typeof content != "object" || roomOfUser === null) return;
        var destSocketId = socketID_UUIDMatch[content.destUUID];
        var signalingData = content.signalingData;
        if (ioServer.sockets.sockets.get(destSocketId)?.data.room !== roomOfUser) return; // same room only

        ioServer.to(destSocketId).emit('signaling', { signalingData: signalingData, fromUUID: MY_UUID, username: nameOfUser });
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