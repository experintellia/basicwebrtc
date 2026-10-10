var wrtc = window;
//@ts-check
function initEzWebRTC(initiator, config) {
    var _this = this;
    this.isConnected = false;
    this.gotOffer = false;
    this.makingOffer = false;
    var gen = Math.floor(Math.random() * 1e9); //counts offers; the answer echoes it, so answers to older offers are dropped

    var rtcConfig = { //Default Values
        'iceServers': [
            {
                "urls": "stun:stun.l.google.com:19302"
            }
        ]
    }
    if (config) {
        for (var i in config) {
            rtcConfig[i] = config[i];
        }
    }

    //Make new peer
    var pc = new wrtc.RTCPeerConnection({ iceServers: rtcConfig.iceServers });

    // Peer-to-peer data (DTLS encrypted end to end). Negotiated: both sides create it, no extra offer.
    var dc = pc.createDataChannel("data", { negotiated: true, id: 0 });
    dc.onopen = () => _this.emitEvent("open");
    dc.onclose = () => _this.emitEvent("close");
    dc.onmessage = e => { try { var msg = JSON.parse(e.data) } catch (err) { return } if (msg && typeof msg == "object") _this.emitEvent("message", msg) };
    this.send = obj => dc.readyState == "open" && (dc.send(JSON.stringify(obj)), true); // false: not open (yet)
    this.iceUp = () => pc.iceConnectionState == "connected" || pc.iceConnectionState == "completed";

    pc.onsignalingstatechange = function (event) {
        _this.emitEvent("onsignalingstatechange", event);
    }

    pc.onicecandidate = function (e) {
        if (!pc || !e || !e.candidate) return;
        _this.emitEvent("signaling", e.candidate)
    };

    // One video slot per peer (#57): camera and screen share swap its track, no renegotiation.
    // The initiator offers it, the answerer sends on it too; main.js says {video: true|false} over the data channel.
    var video = null, videoTrack = null, degradation = null;
    this.remoteVideo = null; // the peer's video slot, shown while it says {video: true}
    this.setVideo = function (track) {
        videoTrack = track;
        if (video) video.sender.replaceTrack(track).catch(e => console.log("replaceTrack Error", e)); //e.g. closed pc
    }
    this.setDegradation = function (pref) { //What the encoder gives up under load, without renegotiation
        degradation = pref;
        if (!video) return;
        var params = video.sender.getParameters();
        params.degradationPreference = pref;
        video.sender.setParameters(params).catch(e => console.log("setParameters Error", e));
    }

    var knownStreams = {};
    pc.ontrack = function (event) {
        if (event.track.kind == "video") return _this.remoteVideo ||= new MediaStream([event.track]);
        event.streams.forEach(eventStream => {
            if (!knownStreams[eventStream.id]) _this.emitEvent("stream", eventStream);
            knownStreams[eventStream.id] = true;
        });
    }

    // Tiles are removed only when the server says the peer left; until then keep restarting ICE.
    pc.oniceconnectionstatechange = function () {
        _this.emitEvent("icestate", pc.iceConnectionState);
        if (pc.iceConnectionState == "connected" || pc.iceConnectionState == "completed") {
            if (!_this.isConnected) {
                _this.isConnected = true;
                _this.emitEvent("connect", true)
            }
        } else if (["disconnected", "failed"].includes(pc.iceConnectionState) && initiator && !retrying) {
            retrying = true;
            setTimeout(function retry() { //give it a few seconds to come back on its own, then keep restarting until it does
                if (!["disconnected", "failed"].includes(pc.iceConnectionState)) return retrying = false;
                restartIce();
                setTimeout(retry, 5000); //one restart can fail while the path is still down, without any further state change (#22)
            }, 3000);
        }
    };
    var retrying = false;

    function restartIce() {
        pc.restartIce(); //before the rollback, whose negotiationneeded may already create the next offer
        reoffer();
    }

    async function reoffer() { //answer lost, late or broken: negotiationneeded never fires outside stable
        gen++; //answers to the old offer are stale now
        if (pc.signalingState == "have-local-offer") {
            _this.makingOffer = false;
            await pc.setLocalDescription({ type: "rollback" }).catch(e => console.log("rollback error", e));
        }
        negotiate();
    }

    pc.onnegotiationneeded = function () {
        negotiate();
    }

    this.signaling = async function (signalData) { //Handle signaling
        if (signalData == "renegotiate" && initiator) { //Got renegotiate request, so do it
            negotiate();
        } else if (signalData && signalData.type == "offer") { //Got an offer -> Create Answer)
            _this.gotOffer = true;
            await pc.setRemoteDescription(new wrtc.RTCSessionDescription(signalData)) //only the answerer gets offers; have-remote-offer -> have-remote-offer is valid
            if (!video && (video = pc.getTransceivers().find(t => t.receiver.track.kind == "video"))) { // the initiator's video slot: send on it too
                video.direction = "sendrecv"; // before the answer, so it is negotiated
                _this.setVideo(videoTrack);
                if (degradation) _this.setDegradation(degradation);
            }
            await pc.setLocalDescription(await pc.createAnswer());
            _this.emitEvent("signaling", { type: "answer", sdp: opusParams(pc.localDescription.sdp), gen: signalData.gen }) //sdp is readonly per spec: send a munged copy
        } else if (signalData && signalData.type == "answer" && initiator) { //Initiator: Setting answer and starting connection
            if (signalData.gen !== undefined && signalData.gen != gen) return; //answer to an older offer (no gen: older client, accept)
            try {
                await pc.setRemoteDescription(new wrtc.RTCSessionDescription(signalData))
            } catch (e) {
                return console.log("answer error", e); //the offer timeout re-offers; no tight loop on an always-bad answer
            }
            _this.makingOffer = false;
            if (offerPending) { offerPending = false; negotiate(); } //e.g. a "renegotiate" that came in meanwhile
        } else if (signalData && signalData.candidate) { //is a icecandidate thing
            await pc.addIceCandidate(new wrtc.RTCIceCandidate(signalData));
        } else {
            console.log("Some unused signaling data???", signalData)
        }
    }

    var trackSenders = {};
    this.addStream = function (stream) {
        stream.getTracks().forEach(track => {
            trackSenders[track.id] = pc.addTrack(track, stream); //Add all tracks to pc
        })
    }

    this.replaceTrack = function (oldTrack, newTrack) { //Swap the sent mic track without renegotiation
        var sender = trackSenders[oldTrack.id];
        if (!sender) return;
        delete trackSenders[oldTrack.id];
        trackSenders[newTrack.id] = sender;
        sender.replaceTrack(newTrack).catch(e => console.log("replaceTrack Error", e)); //e.g. closed pc
    }

    this.destroy = function () {
        pc.close();
        pc.oniceconnectionstatechange = null
        pc.onicegatheringstatechange = null
        pc.onsignalingstatechange = null
        pc.onicecandidate = null
        pc.ontrack = null
        _this.isConnected = false;
    }

    if (rtcConfig.stream) this.addStream(rtcConfig.stream); //the mic; the answerer's track joins the offer's audio slot
    if (initiator) video = pc.addTransceiver("video", { direction: "sendrecv" }); //triggers the first negotiation

    var offerPending = false;
    async function negotiate() {
        if (_this.makingOffer) //Dont make an offer twice before answer is received, but redo it after
            return offerPending = true;
        //console.log("negotiate", initiator)
        if (initiator) {
            _this.makingOffer = true;
            try {
                const offer = await pc.createOffer();
                if (pc.signalingState != "stable") return _this.makingOffer = false; //dropped, negotiationneeded fires again once stable
                await pc.setLocalDescription(offer);
            } catch (e) {
                _this.makingOffer = false;
                return console.log("offer error", e);
            }
            var myGen = ++gen;
            _this.emitEvent("signaling", { type: "offer", sdp: opusParams(pc.localDescription.sdp), gen: myGen })
            setTimeout(function () { //no answer in time: offer again
                if (gen == myGen && pc.signalingState == "have-local-offer") reoffer();
            }, 5000);
        } else if (_this.gotOffer) { //Dont send renegotiate req before getting at least one offer
            _this.emitEvent("signaling", "renegotiate");
        }
    }

    this.mappedEvents = {};
    this.on = function (eventname, callback) {
        if (_this.mappedEvents[eventname]) {
            _this.mappedEvents[eventname].push(callback)
        } else {
            _this.mappedEvents[eventname] = [callback];
        }
    };

    this.emitEvent = function (eventname) {
        for (var i in this.mappedEvents[eventname]) {
            _this.mappedEvents[eventname][i](arguments[1], arguments[2], arguments[3])
        }
    };
    return this;
}

function opusParams(sdp) {
    var pt = (sdp.match(/a=rtpmap:(\d+) opus\//i) || [])[1];
    if (!pt) return sdp;
    return sdp.replace(new RegExp("(a=fmtp:" + pt + " [^\\r\\n]*)", "g"), function (line) {
        if (!/usedtx=/.test(line)) line += ";usedtx=1";
        if (!/useinbandfec=/.test(line)) line += ";useinbandfec=1";
        return line;
    });
}

function calcCurrentVolumeLevel(stream, callback) { //Returns audio levels for audio stream from 0 - silent; to 2 loud
    //Calc the current volume!
    var audioAontext = window.AudioContext || window.webkitAudioContext;
    var context = new audioAontext();
    var microphone = context.createMediaStreamSource(stream);
    var dest = context.createMediaStreamDestination();

    gainNode = context.createGain();

    var analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    var audioVolume = 0;
    var oldAudioVolume = 0;
    function calcVolume() {
        if (context.state == "closed") return; //stopped
        requestAnimationFrame(calcVolume);
        analyser.getByteTimeDomainData(dataArray);
        var mean = 0;
        for (var i = 0; i < dataArray.length; i++) {
            mean += Math.abs(dataArray[i] - 127);
        }
        mean /= dataArray.length;
        mean = Math.round(mean);
        if (mean < 1.2)
            audioVolume = 0;
        else if (mean < 2.5)
            audioVolume = 1;
        else
            audioVolume = 2;

        if (audioVolume != oldAudioVolume) {
            callback(audioVolume);
            oldAudioVolume = audioVolume;
        }
    }
    calcVolume();
    microphone.connect(gainNode);
    gainNode.connect(analyser); //get sound  
    analyser.connect(dest);
    return () => context.close(); //stops the meter
}