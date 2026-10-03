const API_VERSION = 1.4;

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
// Per tab only: survives reloads and other rooms, never shared with other tabs or later visits.
const stored = k => { try { return sessionStorage[k] } catch { } }; // throws when storage is blocked
const store = (k, v) => { try { sessionStorage[k] = v } catch { } };
var username = getUrlParam("username", stored("username") || "NA");
const knockId = stored("knockId") || uuidv4(); // a locked room's reject cooldown outlives a reload
store("knockId", knockId);
var roomname = getUrlParam("roomname", false);

if (!roomname) {
  roomname = "r" + Math.random().toString().replace(".", "")
  location.hash = paramsWithout("#", location.hash, [], { roomname }) // & not a 2nd "#"
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
var screenMotion = false; //Screen share mode: false = Detail (sharp text), true = Performance (smooth motion)
var selectedCameraId = stored("camera") || null;
const MIC = { echoCancellation: true, noiseSuppression: true };
// The chosen device, or the browser's pick if it is gone: Chromium ignores a deviceId that is only "ideal"
const getDevice = (kind, c, id) => navigator.mediaDevices.getUserMedia({ [kind]: id ? { ...c, deviceId: { exact: id } } : c })
  .catch(e => id ? getDevice(kind, c) : Promise.reject(e));

async function updateDeviceLists() { //Show a picker only if there is more than one device
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (kind, label, select, btn, cur) => {
    const list = devices.filter(d => d.kind == kind);
    $(select).replaceChildren(...list.map((d, i) => new Option(d.label || label + " " + (i + 1), d.deviceId)));
    $(select).value = list.some(d => d.deviceId == cur) ? cur : list[0]?.deviceId;
    $(btn).style.display = list.length > 1 ? "" : "none";
  };
  fill("videoinput", "Camera", "#cameraSelect", "#selectCameraBtn", selectedCameraId);
  fill("audioinput", "Microphone", "#micSelect", "#selectMicBtn", webRTCConfig["stream"]?.getAudioTracks()[0].getSettings().deviceId);
}
navigator.mediaDevices.addEventListener("devicechange", updateDeviceLists);

function showMsg(name, msg) {
  const line = document.createElement("div");
  if (name) {
    const b = document.createElement("b");
    b.className = "chatName";
    b.textContent = name;
    line.append(b, ": ");
  }
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
  if ($("#chatDiv").hidden) {
    for (const b of [$("#moreBtn"), $("#addRemoveChatBtn")]) b.dataset.unread = (+b.dataset.unread || 0) + 1;
  }
}

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
  if (data.signalingData == "reset") return removePeer(fromUUID);
  if (!pcs[fromUUID]) {
    if (data.signalingData?.type != "offer") return; // only an offer starts a call: late candidates of a removed peer would leave a ghost
    createRemoteSocket(false, fromUUID)
  }
  pcs[fromUUID].signaling(data.signalingData).catch(e => console.log("signaling error", e));
})

// MY_UUID is new per page load: a known UUID means that page's socket reconnected. It already dropped
// peers whose ICE is down and lists the rest in keep; keep the call only if both sides still have it.
socket.on("userJoined", function (content) {
  const UUID = content["UUID"] || null;
  if (pcs[UUID]?.iceUp() && content.keep?.includes(MY_UUID)) return pcs[UUID].left = false;
  createRemoteSocket(true, UUID);
})

const sendToPeers = obj => { for (var i in pcs) pcs[i].send(obj) };
window.addEventListener("pagehide", () => sendToPeers({ bye: true })); // hang up, tab closed or reload
const nameOf = UUID => { const n = allUserStreams[UUID] && allUserStreams[UUID]["username"]; return n && n != "NA" ? n : "" };

function setAudioLevel(UUID, level) {
  if (allUserStreams[UUID]) allUserStreams[UUID].muted = level < 0; // re-shown by updateUserLayout
  const tile = byId(UUID);
  if (!tile) return;
  tile.querySelector(".audioMuted")?.remove();
  if (level < 0) { //Muted
    tile.insertAdjacentHTML("beforeend", '<div style="position:absolute; top: 0px; color: white; font-size: 1.7em; padding: 10px;" class="audioMuted"><i class="fas fa-microphone-alt-slash"></i></div>');
  } else {
    tile.querySelector(".userPlaceholder").style.border = "2px solid rgb(255 255 255 / " + level * 50 + "%)";
  }
}

// Peer left the server: keep the call while ICE is up, drop it once ICE goes down (crash, lost network).
socket.on("userDiscconected", function (UUID) {
  if (!pcs[UUID]) return;
  if (pcs[UUID].iceUp()) pcs[UUID].left = true;
  else removePeer(UUID);
})

// Every (re)connect registers and joins again; peers with live ICE are kept, the rest rebuilt by the rejoin.
socket.on("connect", function () {
  socket.emit("registerUUID", { "UUID": MY_UUID, "UUID_KEY": MY_UUID_KEY }, async function (err) {
    if (err) return console.log(err);
    await mediaReady;
    for (const id in pcs) if (!pcs[id].iceUp()) removePeer(id);
    joinRoom(members => { // userJoined/userDiscconected missed while offline: resync who left the server
      for (const id in pcs) if ((pcs[id].left = !members.includes(id)) && !pcs[id].iceUp()) removePeer(id);
      setStatus(MY_UUID, "");
    });
  })
});
socket.on("disconnect", () => setStatus(MY_UUID, "reconnecting…"));

function setStatus(UUID, text) { // status line on a tile, e.g. "connecting…"; "" hides it
  allUserStreams[UUID]["status"] = text;
  const el = byId(UUID)?.querySelector(".peerStatus");
  if (el) el.textContent = text;
}

var mediaReady = (async function () {
  allUserStreams[MY_UUID] = { username: username };
  updateUserLayout();
  try {
    if (camOnAtStart) { // ask for both permissions at once
      (await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => null))?.getTracks().forEach(t => t.stop()); // no camera: still join with the mic
    }
    var stream = await getDevice("audio", MIC, stored("mic"));
  } catch (error) {
    $("#micError").hidden = false;
    console.log('getUserMedia error! Got this error: ', error);
    return new Promise(() => { }); // never join without a mic
  }
  webRTCConfig["stream"] = stream;
  allUserStreams[MY_UUID]["audiostream"] = stream;
  startMicMeter();
  updateDeviceLists(); //Labels are only available after permission is granted
  updateUserLayout();
  if (camOnAtStart) { //enable cam on start if set
    setTimeout(toggleCamera, 1000)
  }
  // Lobby: the own tile is the preview (level ring, camera), the call buttons pick devices. Join only after it.
  $("#nameInput").value = username == "NA" ? "" : username;
  $("#lobby").hidden = false;
  if (!matchMedia("(pointer: coarse)").matches) $("#nameInput").focus();
  await new Promise(r => $("#lobby").onsubmit = e => { e.preventDefault(); r(); });
  $("#lobby").hidden = true;
  setName($("#nameInput").value);
  setStatus(MY_UUID, "connecting…"); // own tile shows join progress
})();

var stopMicMeter;
function startMicMeter() { // the meter reads the track it started with: restart it after a mic switch
  stopMicMeter?.();
  stopMicMeter = calcCurrentVolumeLevel(webRTCConfig["stream"], function (currentAudioLvl) {
    if (!micMuted) {
      sendToPeers({ audioLvl: currentAudioLvl });
      setAudioLevel(MY_UUID, currentAudioLvl);
    }
  });
}

$("#micSelect").onchange = async function () { //Swap the mic track in place, so peers don't need to renegotiate
  this.disabled = true; //No overlapping switches
  const stream = webRTCConfig["stream"], oldTrack = stream.getAudioTracks()[0];
  try {
    const newTrack = (await navigator.mediaDevices.getUserMedia({ audio: { ...MIC, deviceId: { exact: this.value } } })).getAudioTracks()[0];
    newTrack.enabled = !micMuted;
    for (var i in pcs) pcs[i].replaceTrack(oldTrack, newTrack);
    stream.removeTrack(oldTrack); // same stream object: new peers and the mute button get the new track
    stream.addTrack(newTrack);
    oldTrack.stop(); // only now: a failed switch keeps the old mic
    store("mic", newTrack.getSettings().deviceId);
    startMicMeter();
  } catch (error) {
    alert("Could not switch microphone!")
    console.log('getUserMedia error! Got this error: ', error);
  } finally {
    this.disabled = false;
    updateDeviceLists();
  }
}

$("#muteUnmuteMicBtn").onclick = function () {
  micMuted = !micMuted;
  this.innerHTML = micMuted ? '<i class="fas fa-microphone-alt-slash"></i>' : '<i class="fas fa-microphone-alt"></i>';
  if (allUserStreams[MY_UUID] && allUserStreams[MY_UUID]["audiostream"]) {
    allUserStreams[MY_UUID]["audiostream"].getAudioTracks()[0].enabled = !micMuted;
    if (micMuted) sendToPeers({ audioLvl: -1 });
  }
}

$("#addRemoveChatBtn").onclick = function () {
  const open = $("#chatDiv").hidden;
  $("#chatDiv").hidden = !open;
  if (open) for (const b of [$("#moreBtn"), this]) delete b.dataset.unread;
  if (open && !matchMedia("(pointer: coarse)").matches) $("#chatInputText").focus(); // no keyboard covering the chat on phones
}
$("#moreBtn").onclick = () => $("#moreMenu").hidden = !$("#moreMenu").hidden;
$("#moreMenu").onclick = () => $("#moreMenu").hidden = true; // picking an item closes it
addEventListener("click", e => $("#moreGroup").contains(e.target) || ($("#moreMenu").hidden = true));
$("#chatCloseBtn").onclick = () => $("#addRemoveChatBtn").click();

$("#chatSendBtn").onclick = sendMsg;
$("#chatInputText").onkeydown = e => { if (e.key == "Enter") sendMsg() };

function sendMsg() {
  const chat = $("#chatInputText").value.trim();
  $("#chatInputText").value = "";
  if (!chat) return;
  sendToPeers({ chat: chat });
  showMsg(nameOf(MY_UUID), chat);
}

var mediaBusy = false; // one camera/screen change at a time: an overlapping one would leak a live stream
async function exclusive(fn) {
  if (mediaBusy) return;
  mediaBusy = true;
  try { await fn(); } finally { mediaBusy = false; }
}

$("#addRemoveScreenBtn").onclick = () => exclusive(async function () {
  if (screenActive) return stopVideo();
  try {
    var stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    console.log('getDisplayMedia error! Got this error: ', e);
    if (e.name != "NotAllowedError") alert("Could not get your Screen!"); // NotAllowedError = picker cancelled
    return;
  }
  if (camActive) stopVideo(); // only now: a cancelled picker keeps the camera
  screenActive = true;
  startVideo(stream, $("#addRemoveScreenBtn"));
  applyScreenMode();
  $("#screenModeBtn").hidden = false;
});

$("#screenModeBtn").onclick = function () {
  screenMotion = !screenMotion;
  applyScreenMode();
}
$("#screenModeBtn").onkeydown = e => (e.key == "Enter" || e.key == " ") && (e.preventDefault(), e.target.click());

function applyScreenMode() { //contentHint is the main effect, degradationPreference makes it explicit for the encoder
  const track = allUserStreams[MY_UUID]["videostream"].getVideoTracks()[0];
  track.contentHint = screenMotion ? "motion" : "detail";
  for (var i in pcs) pcs[i].setDegradation(track, screenMotion ? "maintain-framerate" : "maintain-resolution");
  $("#screenModeBtn").setAttribute("aria-pressed", screenMotion);
  $("#screenModeBtn i").className = screenMotion ? "fas fa-running" : "fas fa-font";
  $("#screenModeBtn").title = screenMotion ? "screen share: smooth motion (click for sharp text)" : "screen share: sharp text (click for smooth motion)";
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
    newTrack.onended = oldTrack.onended;
    store("camera", selectedCameraId);
    for (var i in pcs) pcs[i].replaceTrack(oldTrack, newTrack);
    stream.removeTrack(oldTrack);
    stream.addTrack(newTrack);
    updateUserLayout();
  } catch (error) {
    alert("Could not switch camera!")
    console.log('getUserMedia error! Got this error: ', error);
    selectedCameraId = null;
    if (camActive) stopVideo(); //Turn the dead camera off (not via toggleCamera: its busy guard could skip it; skip if turned off or replaced by a screen share meanwhile)
    updateDeviceLists();
  } finally {
    this.disabled = false;
  }
}

function toggleCamera() {
  return exclusive(async function () {
    if (screenActive) stopVideo();
    if (camActive) return stopVideo();
    try {
      var stream = await getDevice("video", { facingMode: "user" }, selectedCameraId);
    } catch (error) {
      alert("Could not get your Camera! Be sure you have one connected and it is not used by any other process!")
      console.log('getUserMedia error! Got this error: ', error);
      return;
    }
    selectedCameraId = stream.getVideoTracks()[0].getSettings().deviceId || selectedCameraId;
    store("camera", selectedCameraId);
    updateDeviceLists(); //Labels are only available after permission is granted
    camActive = true;
    startVideo(stream, $("#addRemoveCameraBtn"));
  });
}

function startVideo(stream, btn) {
  btn.style.color = "#030356";
  stream.getVideoTracks()[0].onended = () => allUserStreams[MY_UUID]["videostream"] == stream && stopVideo(); // unplugged camera, browser's "Stop sharing" bar
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
  $("#screenModeBtn").hidden = true;
  updateUserLayout();
}

// `part` (location.hash/search) minus `drop` plus `add`; other params stay byte-identical (getUrlVars parses them raw)
function paramsWithout(sep, part, drop, add = {}) {
  const kept = part.slice(1).split("&").filter(p => p && !drop.includes(p.split("=")[0]));
  for (const k in add) kept.push(k + "=" + encodeURIComponent(add[k]));
  return kept.length ? sep + kept.join("&") : "";
}

$("#changeNameBtn").onclick = function () {
  const name = prompt("Your name:", username == "NA" ? "" : username);
  if (name !== null) setName(name);
}

function setName(name) {
  username = name.trim().slice(0, 64) || "NA";
  history.replaceState(null, "", paramsWithout("#", location.hash, ["username"], { username })); // survives reloads
  store("username", username);
  if (allUserStreams[MY_UUID]) allUserStreams[MY_UUID].username = username;
  sendToPeers({ username });
  updateUserLayout();
}

$("#shareBtn").onclick = function () {
  const url = location.origin + location.pathname + paramsWithout("?", location.search, ["username", "camon"]) + paramsWithout("#", location.hash, ["username", "camon"]);
  const copy = () => { $("#shareLink").value = url; $("#shareDialog").showModal(); $("#shareLink").select(); };
  if (!navigator.share) return copy();
  navigator.share({ title: "Join my call", url }).catch(e => e.name != "AbortError" && copy()); // AbortError = user cancelled
}

$("#copyLinkBtn").onclick = function () {
  if (!navigator.clipboard) return $("#shareLink").select();
  navigator.clipboard.writeText($("#shareLink").value).then(() => this.innerHTML = '<i class="fas fa-check"></i> Copied!', () => $("#shareLink").select());
}
$("#shareDialog").onclose = () => $("#copyLinkBtn").innerHTML = '<i class="far fa-copy"></i> Copy';

$("#cancelCallBtn").onclick = function () { // TV switch-off effect, then end screen
  this.onclick = null;
  for (const s of [webRTCConfig["stream"], allUserStreams[MY_UUID]["videostream"]]) s?.getTracks().forEach(t => t.stop());
  socket.disconnect();
  document.body.insertAdjacentHTML("beforeend", '<div id="topDiv"></div><div id="bottomDiv"></div>');
  setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="centerDiv"></div>'), 500);
  setTimeout(() => location = "./endcall.html", 1400);
}

//This is where the WEBRTC Magic happens!!!
function createRemoteSocket(initiator, UUID) {
  if (initiator) socket.emit("signaling", { destUUID: UUID, signalingData: "reset" }); // peer drops any old pc before our offer
  if (pcs[UUID]) removePeer(UUID); // same user rejoined: start over
  var pc = pcs[UUID] = new initEzWebRTC(initiator, webRTCConfig);
  if (allUserStreams[MY_UUID]["videostream"]) pc.addStream(allUserStreams[MY_UUID]["videostream"]);
  if (screenActive) applyScreenMode(); //late joiner gets the current mode
  pc.on("signaling", function (data) {
    // Socket first: one ordered path, and a data channel can read "open" while nothing gets through. Channel only without a server.
    if (socket.connected) socket.emit("signaling", { destUUID: UUID, signalingData: data });
    else pc.send({ signaling: data });
  })
  allUserStreams[UUID] = allUserStreams[UUID] || {}; // show the tile right away, with its status
  allUserStreams[UUID]["status"] = "connecting…";
  updateUserLayout();
  pc.on("icestate", function (state) {
    if (pcs[UUID] !== pc) return; // already removed
    // Gone from the server and from ICE. ponytail: a short ICE blip while the peer is off the server also drops it; accepted for fast crash cleanup.
    if (pc.left && !pc.iceUp()) return removePeer(UUID);
    setStatus(UUID, ["connected", "completed"].includes(state) ? "" : pc.isConnected ? "reconnecting…" : "connecting…");
  });
  pc.on("close", () => pcs[UUID] === pc && removePeer(UUID)); // peer left (or closed its connection)
  pc.on("open", () => pc.send({ username: username, audioLvl: micMuted ? -1 : 0 }));
  pc.on("message", function (msg) { // from the peer: untrusted
    if (typeof msg.username == "string") {
      allUserStreams[UUID] = allUserStreams[UUID] || {};
      allUserStreams[UUID]["username"] = msg.username.slice(0, 64);
      updateUserLayout();
    }
    if (typeof msg.audioLvl == "number") setAudioLevel(UUID, msg.audioLvl);
    if (typeof msg.chat == "string") showMsg(nameOf(UUID), msg.chat.slice(0, 2000));
    if (msg.bye) removePeer(UUID);
    if (msg.signaling) pc.signaling(msg.signaling).catch(e => console.log("signaling error", e));
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
  if (!stream.getVideoTracks().length && !byId('audio' + UUID)) { // not in updateUserLayout: that skips while fullscreen
    const audio = fromHTML('<audio autoplay hidden></audio>');
    audio.id = 'audio' + UUID;
    audio.srcObject = stream;
    $("#audioStreams").append(audio);
  }
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
    userDiv.querySelector(".userPlaceholder").textContent = [...(name || i)].slice(0, 2).join("").toUpperCase();
    userDiv.append(Object.assign(document.createElement("div"), { className: "peerStatus", textContent: userStream["status"] || "" }));

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
  for (const i in allUserStreams) if (allUserStreams[i].muted) setAudioLevel(i, -1);
}
document.addEventListener("fullscreenchange", updateUserLayout); // redo what was skipped while fullscreen

var retryJoin = null; // at a locked room's door: joins again once let in
function joinRoom(onJoined) {
  socket.emit("joinRoom", { roomname: getUrlParam("roomname", "unknown"), keep: Object.keys(pcs), name: username, knockId }, function (res) {
    if (!Array.isArray(res)) return retryJoin = () => joinRoom(onJoined), atTheDoor(res.wait);
    $("#lobby").hidden = true;
    $("#knocks").replaceChildren(); // the server sends the open ones again
    showLock(false); // and the lock, if set
    onJoined(res);
  });
}

function atTheDoor(wait) { // locked room: back to the lobby until a member lets us in
  setStatus(MY_UUID, "");
  $("#lobby").hidden = false;
  $("#joinBtn").disabled = true;
  $("#lobbyMsg").textContent = wait ? `You were not let in. You can ask again in ${wait}s.` : "The room is locked. Waiting for someone in the call to let you in…";
  if (wait) setTimeout(() => $("#joinBtn").disabled = false, wait * 1000);
  $("#lobby").onsubmit = e => {
    e.preventDefault();
    setName($("#nameInput").value);
    setStatus(MY_UUID, "connecting…");
    retryJoin();
  };
}
socket.on("knockAnswer", res => res.accept ? retryJoin?.() : atTheDoor(res.wait));

socket.on("knock", function ({ UUID, name }) { // someone at the door: any member decides
  byId("knock" + UUID)?.remove();
  const row = fromHTML('<div class="knock"><span></span><button>Let in</button><button>Deny</button></div>');
  row.id = "knock" + UUID;
  row.firstChild.textContent = (name && name != "NA" ? name : "Someone") + " wants to join";
  row.querySelectorAll("button").forEach((btn, i) => btn.onclick = () => socket.emit("answerKnock", { UUID, accept: !i }));
  $("#knocks").append(row);
});
socket.on("knockDone", UUID => byId("knock" + UUID)?.remove());

var roomLocked = false;
function showLock(locked) {
  roomLocked = locked;
  $("#lockBtn").innerHTML = locked ? '<i class="fas fa-lock-open"></i> Unlock room' : '<i class="fas fa-lock"></i> Lock room';
}
socket.on("locked", function ({ locked, by }) {
  showLock(locked);
  if (by && by != MY_UUID) showMsg("", `${nameOf(by) || "Someone"} ${locked ? "locked the room: newcomers have to be let in" : "unlocked the room"}`);
});
$("#lockBtn").onclick = () => socket.emit("setLocked", !roomLocked);

// iOS Safari can block autoplay of remote audio: any tap retries it
addEventListener("click", () => document.querySelectorAll("#audioStreams audio").forEach(a => a.paused && a.play().catch(() => { })), true);

var resizeTimeout = null;
window.onresize = function () {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(updateUserLayout, 2000)
};
