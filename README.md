# basicWebRTC

Setup your own Videoconference Server for 1on1 and group calls! All Calls are encrypted Peer 2 Peer!

## Functions
* Audio
* Video
* 1on1 and group Calls
* Screenshare

## Install ##

1. Install node and clone this repo
2. run: npm i
3. run: node server.js
4. surf to: http://localhost:3001 (other devices need https, e.g. via the nginx proxy below: browsers only allow mic/camera on https or localhost)

### Room link ###
The only URL parameter is the room: https://IP:3001/#roomname=yourSecretRoom
Your name, mic and camera are picked in the lobby before joining.

### Config Server Listen IP & Port

Change the env variables: listen_ip ("0.0.0.0" default) and listen_port (3001 default)

### Behind a nginx reverse Proxy
```
location /basicwebrtc/ {
	resolver 127.0.0.1 valid=30s;
	proxy_set_header HOST $host;
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection upgrade;
	proxy_pass http://127.0.0.1:8080/;
}
```
## Upgrading ##

`iceservers.json` is no longer tracked by git (it holds your TURN secret). A plain `git pull` deletes it, so keep a copy:

```
cp iceservers.json ~/ && git checkout iceservers.json && git pull && cp ~/iceservers.json .
```

Without it the server still runs, but with public STUN only (no TURN fallback). While you're at it:
* Change the TURN `authSecret` (coturn) and `turnServerCredential`; older versions of this repo committed it.
* Add the TCP TURN url, see below.

Updating is recommended: it includes connection-stability and security fixes.

## STUN and TURN Configuration ##
If your clients are behind firewalls you might need to setup a TURN Server so the connection can fallback to that (Connection is e2e encrypted in any case).

Copy `iceservers.example.json` to `iceservers.json` (not tracked by git, it holds your TURN secret) and add your STUN/TURN urls there. Without it, only public STUN is used.

### Setup your own TURN Server with docker ###
This setup is using COTURN inside docker.
The server is listening on Ports 443 and 4433 because on many firewalls only webtraffic is allowed. So you need to set this up on a second server.

If your server ip is 10.10.10.10 and your want to name it "myturnserver" run it like this:

Run `docker run -d --net=host --restart=always rofl256/turnserver usernameAdmin passwordAdmin realm "10.10.10.10" "10.10.10.10" "10.10.10.10" authSecret`

Don't forget to change the admin username, password and authSecret. 

For more configurations of this  take a look at repo of the container (https://github.com/cracker0dks/turn-server-docker-image) and the COTURN repo itself: https://github.com/coturn/coturn

If you have the turn server running, put it into /iceservers.json
```
[
    {
        "urls": "stun:10.10.10.10:443"
    },
    {
        "urls": ["turn:10.10.10.10:443", "turn:10.10.10.10:443?transport=tcp"],
        "turnServerCredential": "authSecret",
        "username": "webrtcuser"
    }
]
```
The `?transport=tcp` url lets clients on UDP-blocked networks still connect (media stays e2e encrypted, the relay only sees ciphertext).
Change the ips and authSecret as defined on docker run. The username can be set to anything you want or leave it like this then restart the basicwebrtc server.
