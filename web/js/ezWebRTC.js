var wrtc = window;
//@ts-check
function initEzWebRTC(initiator, config) {
    var _this = this;
    this.isConnected = false;
    this.gotOffer = false;
    this.makingOffer = false;

    var rtcConfig = { //Default Values
        offerOptions: {
            offerToReceiveAudio: true, //- depricated - want audio
            offerToReceiveVideo: true  //- depricated - want video
        },
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

    pc.onsignalingstatechange = function (event) {
        _this.emitEvent("onsignalingstatechange", event);
    }

    pc.onicecandidate = function (e) {
        if (!pc || !e || !e.candidate) return;
        _this.emitEvent("signaling", e.candidate)
    };

    var knownStreams = {};
    pc.ontrack = function (event) {
        event.streams.forEach(eventStream => {
            _this.emitEvent('track', event.track, eventStream);
            if (!knownStreams[eventStream.id]) { //emit onStream event
                _this.emitEvent("stream", eventStream);
                eventStream.onremovetrack = (event) => {
                    _this.emitEvent('trackremoved', event.track, eventStream);
                    let tracks = eventStream.getTracks();
                    if (tracks.length == 0) { //If no tracks left
                        _this.emitEvent("streamremoved", eventStream, event.track.kind);
                    }
                    delete trackSenders[event.track.id]
                };
            }
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
        } else if (pc.iceConnectionState == 'disconnected') {
            setTimeout(function () { //give it a few seconds to come back on its own
                if (pc.iceConnectionState == "disconnected" && initiator) restartIce();
            }, 3000);
        } else if (pc.iceConnectionState == 'failed' && initiator) {
            restartIce();
        }
    };

    async function restartIce() {
        if (pc.signalingState == "have-local-offer") { //answer got lost: negotiationneeded never fires outside stable
            _this.makingOffer = false;
            await pc.setLocalDescription({ type: "rollback" }).catch(e => console.log("rollback error", e));
        }
        pc.restartIce(); //triggers negotiationneeded -> negotiate()
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
            await pc.setLocalDescription(await pc.createAnswer(rtcConfig.offerOptions));
            _this.emitEvent("signaling", pc.localDescription)
            if (!initiator)
                requestMissingTransceivers()
        } else if (signalData && signalData.type == "answer" && initiator) { //Initiator: Setting answer and starting connection
            _this.makingOffer = false;
            await pc.setRemoteDescription(new wrtc.RTCSessionDescription(signalData))
            if (offerPending) { offerPending = false; negotiate(); } //e.g. a "renegotiate" that came in meanwhile
        } else if (signalData && signalData.type == "transceive" && initiator) { //Got an request to transrecive
            _this.addTransceiver(signalData.kind, signalData.init)
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

    this.removeStream = function (stream) {
        stream.getTracks().forEach(track => _this.removeTrack(track));
    }

    this.addTrack = function (track, stream) {
        pc.addTrack(track, stream);
    }

    this.removeTrack = function (track) {
        if (trackSenders[track.id]) //Unknown track would throw and abort the caller
            pc.removeTrack(trackSenders[track.id])
    }

    this.replaceTrack = function (oldTrack, newTrack) { //Swap a sent track without renegotiation
        var sender = trackSenders[oldTrack.id];
        if (!sender) return;
        delete trackSenders[oldTrack.id];
        trackSenders[newTrack.id] = sender;
        sender.replaceTrack(newTrack).catch(e => console.log("replaceTrack Error", e)); //e.g. closed pc
    }

    this.addTransceiver = function (kind, init) {
        if (initiator) {
            try {
                pc.addTransceiver(kind, init)
            } catch (err) {
                console.log("addTransceiver Error", err)
                _this.destroy()
            }
        } else {
            _this.emitEvent("signaling", { // request initiator add a transceiver
                type: "transceive",
                kind: kind,
                init: init
            })
        }
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

    if (rtcConfig.stream) {
        this.addStream(rtcConfig.stream); //Add stream at start, this will trigger negotiation
    } else if (initiator) { //start negotiation if we are initiator anyway if we have no stream
        negotiate();
    }

    var offerPending = false;
    async function negotiate() {
        if (_this.makingOffer) //Dont make an offer twice before answer is received, but redo it after
            return offerPending = true;
        //console.log("negotiate", initiator)
        if (initiator) {
            _this.makingOffer = true;
            try {
                const offer = await pc.createOffer(rtcConfig.offerOptions); //Create offer
                if (pc.signalingState != "stable") return _this.makingOffer = false; //dropped, negotiationneeded fires again once stable
                await pc.setLocalDescription(offer);
            } catch (e) {
                _this.makingOffer = false;
                return console.log("offer error", e);
            }
            var o_desc = pc.localDescription;
            _this.emitEvent("signaling", o_desc)
        } else if (_this.gotOffer) { //Dont send renegotiate req before getting at least one offer
            _this.emitEvent("signaling", "renegotiate");
        }
    }

    function requestMissingTransceivers() {
        if (pc.getTransceivers) {
            try {
                pc.getTransceivers().forEach(transceiver => {
                    if (!transceiver.mid && transceiver.sender.track && !transceiver.requested) {
                        transceiver.requested = true // HACK: Safari returns negotiated transceivers with a null mid
                        _this.addTransceiver(transceiver.sender.track.kind)
                    }
                })
            } catch (e) {
                console.log("Faild to add transriver!", e)
            }
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
}