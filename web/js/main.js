const API_VERSION = 1.2;

// The notice in index.html is visible by default; browsers that can't parse or run this script keep seeing it.
if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  throw new Error("WebRTC not supported (old browser or page not served over HTTPS)");
}
document.getElementById("unsupported").remove();

const $ = s => document.querySelector(s);
const byId = id => document.getElementById(id); // ids are peer-supplied UUIDs: never build selectors from them

const MY_UUID = uuidv4();
const MY_UUID_KEY = uuidv4();

var subdir = location.pathname.replace(/[^/]*$/, ""); // folder of the page: "/basicwebrtc/index.html" -> "/basicwebrtc/"

var base64Domain = getUrlParam("base64domain", false);

//ALL # PARAMETERS
var socketDomain = getUrlParam("socketdomain", false); //Domainname with path
var camOnAtStart = getUrlParam("camon", false) == false ? false : true; //Defines if cam should be on at start
var username = getUrlParam("username", "NA");
var roomname = getUrlParam("roomname", false);

if (!roomname) {
  roomname = "r" + Math.random().toString().replace(".", "")
  window.location = location.href + "#roomname=" + roomname
}

if (base64Domain && socketDomain) {
  socketDomain = atob(socketDomain);
}

var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
if (isMobile || !navigator.mediaDevices.getDisplayMedia) { //No Screenshare on mobile devices
  $("#addRemoveScreenBtn").hidden = true;
}

const SocketIO_Options = { withCredentials: false }

var socket;
if (socketDomain) {
  socketDomain = socketDomain.replace('https://', '').replace('http://', '').split("#")[0];
  var domainSplit = socketDomain.split('/');
  socketDomain = 'https://' + domainSplit[0];
  domainSplit.shift();
  subdir = '/' + domainSplit.join('/');
  subdir = subdir.endsWith('/') ? subdir : subdir + '/';
  socket = io(socketDomain, { "path": subdir + "socket.io", ...SocketIO_Options })
} else {
  socket = io("", { "path": subdir + "socket.io", ...SocketIO_Options }); //Connect to socketIo even on subpaths
}

var webRTCConfig = {};

var allUserStreams = {};
var pcs = {}; //Peer connections to all remotes
var micMuted = false;
var camActive = false;
var screenActive = false;
var selectedCameraId = null;

async function updateCameraList() { //Show camera picker only if there is more than one camera
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind == "videoinput");
  if (!cams.some(c => c.deviceId == selectedCameraId)) {
    selectedCameraId = null;
  }
  $("#cameraSelect").replaceChildren(...cams.map((c, i) => new Option(c.label || "Camera " + (i + 1), c.deviceId)));
  $("#cameraSelect").value = selectedCameraId || (cams[0] && cams[0].deviceId);
  $("#selectCameraBtn").style.display = cams.length > 1 ? "" : "none";
}
navigator.mediaDevices.addEventListener("devicechange", updateCameraList);
updateCameraList();

socket.on("msg", function (msg) {
  const line = document.createElement("div");
  msg.split(/(https?:\/\/\S+)/).forEach((part, i) => { // odd parts are links
    if (i % 2) {
      const a = document.createElement("a");
      a.href = a.textContent = part;
      a.target = "_blank";
      a.rel = "noopener";
      line.append(a);
    } else {
      line.append(part);
    }
  });
  $("#chatText").append(line);
  $("#chatText").scrollTop = $("#chatText").scrollHeight;
  if ($("#chatDiv").style.display != "block") {
    $("#addRemoveChatBtn").style.color = "#730303";
  }
})

socket.on("currentIceServers", function (newIceServers) {
  webRTCConfig["iceServers"] = newIceServers;
})

socket.on("API_VERSION", function (serverAPI_VERSION) {
  if (API_VERSION != serverAPI_VERSION) {
    alert("SERVER has a different API Version (Client: v" + API_VERSION + " Server: v" + serverAPI_VERSION + ")! This can cause problems, so be warned!")
  }
})

socket.on("signaling", function (data) {
  var fromUUID = data.fromUUID;
  if (data.username) { // before createRemoteSocket, so the new tile shows the name
    allUserStreams[fromUUID] = allUserStreams[fromUUID] || {};
    allUserStreams[fromUUID]["username"] = data.username;
  }
  if (!pcs[fromUUID]) {
    createRemoteSocket(false, fromUUID)
  }
  pcs[fromUUID].signaling(data.signalingData).catch(e => console.log("signaling error", e));
})

socket.on("userJoined", function (content) {
  createRemoteSocket(true, content["UUID"] || null)
})

socket.on("userName", function (content) {
  if (!allUserStreams[content.fromUUID]) return;
  allUserStreams[content.fromUUID].username = content.username;
  updateUserLayout();
})

socket.on("currentAudioLvl", function (content) {
  setAudioLevel(content["fromUUID"], content["currentAudioLvl"] || 0);
})

function setAudioLevel(UUID, level) {
  const tile = byId(UUID);
  if (!tile) return;
  tile.querySelector(".audioMuted")?.remove();
  if (level < 0) { //Muted
    tile.insertAdjacentHTML("beforeend", '<div style="position:absolute; top: 0px; color: white; font-size: 1.7em; padding: 10px;" class="audioMuted"><i class="fas fa-microphone-alt-slash"></i></div>');
  } else {
    tile.querySelector(".userPlaceholder").style.border = "2px solid rgb(255 255 255 / " + level * 50 + "%)";
  }
}

socket.on("userDiscconected", removePeer)

// Every (re)connect is a fresh join, like a page reload: drop all peers, register, join again.
socket.on("connect", function () {
  for (var id in pcs) removePeer(id);
  socket.emit("registerUUID", { "UUID": MY_UUID, "UUID_KEY": MY_UUID_KEY }, async function (err) {
    if (err) return console.log(err);
    await mediaReady;
    joinRoom();
  })
});

var mediaReady = (async function () {
  try {
    if (camOnAtStart) { // ask for both permissions at once
      (await navigator.mediaDevices.getUserMedia({ video: true, audio: true })).getTracks().forEach(t => t.stop());
    }
    var stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { 'echoCancellation': true, 'noiseSuppression': true }
    });
  } catch (error) {
    alert("Could not get your Mic! You need at least one Mic!")
    console.log('getUserMedia error! Got this error: ', error);
    return new Promise(() => { }); // never join without a mic
  }
  webRTCConfig["stream"] = stream;
  allUserStreams[MY_UUID] = { audiostream: stream, username: username };
  calcCurrentVolumeLevel(stream, function (currentAudioLvl) {
    if (!micMuted) {
      socket.emit('currentAudioLvl', currentAudioLvl);
      setAudioLevel(MY_UUID, currentAudioLvl);
    }
  });
  updateUserLayout();
  if (camOnAtStart) { //enable cam on start if set
    setTimeout(toggleCamera, 1000)
  }
})();

$("#muteUnmuteMicBtn").onclick = function () {
  micMuted = !micMuted;
  this.innerHTML = micMuted ? '<i class="fas fa-microphone-alt-slash"></i>' : '<i class="fas fa-microphone-alt"></i>';
  if (allUserStreams[MY_UUID] && allUserStreams[MY_UUID]["audiostream"]) {
    allUserStreams[MY_UUID]["audiostream"].getAudioTracks()[0].enabled = !micMuted;
    if (micMuted) socket.emit('currentAudioLvl', -1);
  }
}

$("#addRemoveChatBtn").onclick = function () {
  const open = $("#chatDiv").style.display != "block";
  $("#chatDiv").style.display = open ? "block" : "none";
  this.style.color = open ? "#030356" : "black";
  if (open) $("#chatInputText").focus();
}

$("#chatSendBtn").onclick = sendMsg;
$("#chatInputText").onkeydown = e => { if (e.key == "Enter") sendMsg() };

function sendMsg() {
  socket.emit('sendMsg', $("#chatInputText").value.trim());
  $("#chatInputText").value = "";
}

$("#addRemoveScreenBtn").onclick = async function () {
  if (camActive) await toggleCamera();
  if (screenActive) return stopVideo();
  try {
    var stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    console.log('getDisplayMedia error! Got this error: ', e);
    alert("Could not get your Screen!")
    return;
  }
  screenActive = true;
  stream.getVideoTracks()[0].onended = () => screenActive && stopVideo(); // browser's "Stop sharing" bar
  startVideo(stream, $("#addRemoveScreenBtn"));
}

$("#addRemoveCameraBtn").onclick = toggleCamera;

$("#cameraSelect").onchange = async function () {
  selectedCameraId = this.value;
  if (!camActive) return toggleCamera();
  //Swap the video track in place, so peers don't need to renegotiate
  this.disabled = true; //No overlapping switches
  var stream = allUserStreams[MY_UUID]["videostream"];
  var oldTrack = stream.getVideoTracks()[0];
  oldTrack.stop(); //Stop first, many phones can't open two cameras at once
  try {
    var newTrack = (await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: selectedCameraId } } })).getVideoTracks()[0];
    if (!camActive) return newTrack.stop(); //camera was turned off meanwhile
    for (var i in pcs) pcs[i].replaceTrack(oldTrack, newTrack);
    stream.removeTrack(oldTrack);
    stream.addTrack(newTrack);
    updateUserLayout();
  } catch (error) {
    alert("Could not switch camera!")
    console.log('getUserMedia error! Got this error: ', error);
    selectedCameraId = null;
    await toggleCamera(); //Turn the dead camera off
    updateCameraList();
  } finally {
    this.disabled = false;
  }
}

async function toggleCamera() {
  if (screenActive) stopVideo();
  if (camActive) return stopVideo();
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : { 'facingMode': "user" }, audio: false });
  } catch (error) {
    alert("Could not get your Camera! Be sure you have one connected and it is not used by any other process!")
    console.log('getUserMedia error! Got this error: ', error);
    return;
  }
  selectedCameraId = stream.getVideoTracks()[0].getSettings().deviceId || selectedCameraId;
  updateCameraList(); //Labels are only available after permission is granted
  camActive = true;
  startVideo(stream, $("#addRemoveCameraBtn"));
}

function startVideo(stream, btn) {
  btn.style.color = "#030356";
  for (var i in pcs) pcs[i].addStream(stream); //Add stream to all peers
  allUserStreams[MY_UUID] = allUserStreams[MY_UUID] || {};
  allUserStreams[MY_UUID]["videostream"] = stream;
  updateUserLayout();
}

function stopVideo() { // camera and screen share use the same slot
  const stream = allUserStreams[MY_UUID]["videostream"];
  for (var i in pcs) pcs[i].removeStream(stream); //remove stream from all peers
  stream.getTracks().forEach(track => track.stop());
  delete allUserStreams[MY_UUID]["videostream"];
  $("#addRemoveCameraBtn").style.color = $("#addRemoveScreenBtn").style.color = "black";
  camActive = screenActive = false;
  updateUserLayout();
}

// Hash minus `drop` plus `add`; other params stay byte-identical (getUrlVars parses them raw)
function hashWithout(drop, add = {}) {
  const kept = location.hash.slice(1).split("&").filter(p => p && !drop.includes(p.split("=")[0]));
  for (const k in add) kept.push(k + "=" + encodeURIComponent(add[k]));
  return "#" + kept.join("&");
}

$("#changeNameBtn").onclick = function () {
  const name = prompt("Your name:", username == "NA" ? "" : username);
  if (name === null) return;
  username = name.trim().slice(0, 64) || "NA";
  history.replaceState(null, "", hashWithout(["username"], { username })); // survives reloads
  if (allUserStreams[MY_UUID]) allUserStreams[MY_UUID].username = username;
  socket.emit("setName", username);
  updateUserLayout();
}

$("#shareBtn").onclick = function () {
  const url = location.origin + location.pathname + location.search + hashWithout(["username", "camon"]);
  const copy = () => prompt("Share this link:", url); // ponytail: no Web Share (desktop Firefox) -> copy from prompt
  if (!navigator.share) return copy();
  navigator.share({ title: "Join my call", url }).catch(e => e.name != "AbortError" && copy()); // AbortError = user cancelled
}

$("#cancelCallBtn").onclick = function () { // TV switch-off effect, then end screen
  document.body.insertAdjacentHTML("beforeend", '<div id="topDiv"></div><div id="bottomDiv"></div>');
  setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="centerDiv"></div>'), 500);
  setTimeout(() => location = "./endcall.html", 1400);
}

//This is where the WEBRTC Magic happens!!!
function createRemoteSocket(initiator, UUID) {
  if (pcs[UUID]) removePeer(UUID); // same user rejoined: start over
  var pc = pcs[UUID] = new initEzWebRTC(initiator, webRTCConfig);
  if (allUserStreams[MY_UUID]["videostream"]) pc.addStream(allUserStreams[MY_UUID]["videostream"]);
  pc.on("signaling", function (data) {
    socket.emit("signaling", { destUUID: UUID, signalingData: data })
  })
  allUserStreams[UUID] = allUserStreams[UUID] || {}; // show the tile right away, with its status
  allUserStreams[UUID]["status"] = "connecting…";
  updateUserLayout();
  pc.on("icestate", function (state) {
    if (pcs[UUID] !== pc) return; // already removed
    allUserStreams[UUID]["status"] = ["connected", "completed"].includes(state) ? "" : pc.isConnected ? "reconnecting…" : "connecting…";
    const el = byId(UUID)?.querySelector(".peerStatus");
    if (el) el.textContent = allUserStreams[UUID]["status"];
  });
  pc.on("stream", function (stream) {
    gotRemoteStream(stream, UUID)
  });
  pc.on("streamremoved", function (stream, kind) {
    if (kind == "video") {
      delete allUserStreams[UUID]["videostream"];
      updateUserLayout();
    }
  });
}

function removePeer(UUID) {
  if (pcs[UUID]) pcs[UUID].destroy();
  delete pcs[UUID];
  delete allUserStreams[UUID];
  byId('audio' + UUID)?.remove();
  updateUserLayout();
}

function gotRemoteStream(stream, UUID) {
  allUserStreams[UUID] = allUserStreams[UUID] || {};
  allUserStreams[UUID][stream.getVideoTracks().length ? "videostream" : "audiostream"] = stream;
  updateUserLayout();
}

function fromHTML(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function updateUserLayout() {
  if (document.fullscreenElement) { //Dont do things on fullscreen
    return;
  }
  var allUserDivs = {};
  for (var i in allUserStreams) {
    var userStream = allUserStreams[i];
    var name = userStream["username"] && userStream["username"] != "NA" ? userStream["username"] : "";

    var userDiv = fromHTML(`<div class="videoplaceholder">
      <div class="userPlaceholderContainer">
        <div class="userPlaceholder"></div>
      </div>
    </div>`);
    userDiv.id = i;
    userDiv.querySelector(".userPlaceholder").textContent = (name || i).substr(0, 2).toUpperCase();
    if (i != MY_UUID) userDiv.append(Object.assign(document.createElement("div"), { className: "peerStatus", textContent: userStream["status"] || "" }));

    if (userStream["audiostream"] && i !== MY_UUID && !byId('audio' + i)) {
      const audio = fromHTML('<audio autoplay hidden></audio>');
      audio.id = 'audio' + i;
      audio.srcObject = userStream["audiostream"];
      $("#audioStreams").append(audio);
    }

    if (userStream["videostream"]) {
      var mirror = i == MY_UUID && !screenActive && userStream["videostream"].getVideoTracks()[0].getSettings().facingMode != "environment"; //Don't mirror rear cameras
      userDiv.append(fromHTML(`<div class="userCont" style="position: absolute; width: 100%; height: 100%;">
          <div style="top: 0px; width: 100%;">
            <div class="userName" style="position: absolute; color: white; top: 7px; left: 7px; font-size: 1.3em; z-index:10; text-shadow: 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000, -1px 0 0 #000;"></div>
            <video style="${mirror ? "transform: scaleX(-1);" : ""}" autoplay muted></video>
            <button title="Enable Picture in Picture" style="cursor:pointer; position:absolute; top:5px; right:10px; background:transparent; border:0px;" class="pipBtn">
              <img style="width: 30px;" src="./images/picInPic.png">
            </button>
          </div>
        </div>`));
      userDiv.querySelector(".userName").textContent = name ? name.charAt(0).toUpperCase() + name.slice(1) : i.substr(0, 2).toUpperCase();
      const video = userDiv.querySelector("video");
      video.srcObject = userStream["videostream"];
      userDiv.querySelector(".userPlaceholderContainer").hidden = true;

      const pipBtn = userDiv.querySelector(".pipBtn");
      pipBtn.hidden = mirror || !document.pictureInPictureEnabled;
      pipBtn.onclick = () => document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture();

      if (i != MY_UUID) {
        video.style.cursor = "pointer";
        video.onclick = () => video.requestFullscreen();
      }
    }

    allUserDivs[i] = userDiv;
  }

  const mediaDiv = $("#mediaDiv");
  mediaDiv.replaceChildren();
  var streamCnt = Object.keys(allUserDivs).length;

  if (streamCnt == 2) { //Display 2 users side by side
    for (var i in allUserDivs) {
      if (i == MY_UUID) {
        allUserDivs[i].classList.add("selfPreview");
        Object.assign(allUserDivs[i].style, { width: '20%', height: '30%', position: 'absolute', left: '20px', bottom: 'var(--selfPreviewBottomOffset)', zIndex: '1' });
      } else {
        Object.assign(allUserDivs[i].style, { width: '100%', height: '100%', float: 'left' });
      }
      mediaDiv.append(allUserDivs[i])
    }
  } else {
    var lineCnt = Math.round(Math.sqrt(streamCnt));
    var lines = [];
    for (var l = 0; l < lineCnt; l++) {
      lines.push(mediaDiv.appendChild(document.createElement("div")));
    }
    let userPerLine = streamCnt <= 2 ? 1 : Math.ceil(streamCnt / lineCnt);
    let cucnt = 0;
    for (var i in allUserDivs) {
      Object.assign(allUserDivs[i].style, { width: 100 / userPerLine + '%', height: 100 / lineCnt + '%', float: 'left' });
      lines[Math.floor(cucnt / userPerLine)].append(allUserDivs[i])
      cucnt++;
    }

    var lastLine = lines[lineCnt - 1];
    if (lastLine && lastLine.children.length != userPerLine) { // center an incomplete last line
      for (const d of lastLine.children) d.style.left = (100 / userPerLine) / 2 + "%";
    }
  }

  for (const cont of document.querySelectorAll(".userCont")) {
    const video = cont.querySelector("video");
    video.style.maxWidth = cont.offsetWidth + 'px';
    video.style.maxHeight = cont.offsetHeight + 'px';
    video.play().catch(() => { });
  }
}

function joinRoom() {
  socket.emit("joinRoom", { roomname: getUrlParam("roomname", "unknown"), username: username });
}

var resizeTimeout = null;
window.onresize = function () {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(updateUserLayout, 2000)
};
