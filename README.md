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
3. set up a TURN server and `iceservers.json`, see [STUN and TURN](#stun-and-turn-configuration)
4. run: node server.js
5. surf to: http://localhost:3001 (other devices need https, e.g. via the nginx proxy below: browsers only allow mic/camera on https or localhost)

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
	proxy_pass http://127.0.0.1:3001/;
}
```
## Upgrading ##

`iceservers.json` is no longer tracked by git (it holds your TURN secret). A plain `git pull` deletes it, so keep a copy:

```
cp iceservers.json ~/ && git checkout iceservers.json && git pull && cp ~/iceservers.json .
```

Without it the server still runs, but with public STUN only (no TURN fallback). While you're at it:
* Change the TURN `authSecret` (coturn) and `turnServerCredential`; older versions of this repo committed it.
* Add the TCP and TLS TURN urls, see below.

Updating is recommended: it includes connection-stability and security fixes.

## STUN and TURN Configuration ##
Run a TURN server. Calls go peer to peer when they can, but two phones on mobile data (carrier-grade NAT), a symmetric NAT or a network that blocks UDP can only connect through a TURN relay. The relay only sees encrypted media. Without TURN such calls never connect, and the tile says "no relay configured: some networks can't connect".

Copy `iceservers.example.json` (public STUN only) to `iceservers.json` (not tracked by git, it holds your TURN secret) and add your TURN server as shown below.

### Setup your own TURN Server with docker ###
This setup is using COTURN inside docker.
The server is listening on Ports 443 and 4433 because on many firewalls only webtraffic is allowed. So you need to set this up on a second server.

If your server ip is 10.10.10.10 and your want to name it "myturnserver" run it like this:

Run `docker run -d --net=host --restart=always -v /etc/letsencrypt/live/turn.example.com/fullchain.pem:/etc/ssl/turn_server_cert.pem:ro -v /etc/letsencrypt/live/turn.example.com/privkey.pem:/etc/ssl/turn_server_pkey.pem:ro rofl256/turnserver usernameAdmin passwordAdmin realm "10.10.10.10" "10.10.10.10" "10.10.10.10" authSecret`

Don't forget to change the admin username, password and authSecret. 

For more configurations of this  take a look at repo of the container (https://github.com/cracker0dks/turn-server-docker-image) and the COTURN repo itself: https://github.com/coturn/coturn

If you have the turn server running as turn.example.com, put it into /iceservers.json
```
[
    {
        "urls": "stun:turn.example.com:443"
    },
    {
        "urls": ["turn:turn.example.com:443", "turn:turn.example.com:443?transport=tcp", "turns:turn.example.com:443?transport=tcp"],
        "turnServerCredential": "authSecret",
        "username": "webrtcuser"
    }
]
```
The `?transport=tcp` url lets clients on UDP-blocked networks still connect. Firewalls that inspect traffic also drop plain TURN over TCP on 443; the `turns:` url (TURN over TLS) gets through them. It needs a certificate for that name (e.g. from Let's Encrypt), mounted by the two `-v` options above: the image rewrites its coturn config on every start, so `cert=`/`pkey=` edits don't stick. Restart the container after a renewal. coturn accepts TLS and plain TURN on the same port.
Change the names and authSecret as defined on docker run. The username can be set to anything you want or leave it like this then restart the basicwebrtc server.

## Credits ##
Icons: [Font Awesome Free](https://fontawesome.com) 5.13.1 (icons CC BY 4.0, fonts SIL OFL 1.1, code MIT), see `web/webfonts/LICENSE.txt` (with the full OFL 1.1 and MIT texts).
