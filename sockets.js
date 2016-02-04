/**
 * Connections
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Abstraction layer for multi-process SockJS connections.
 *
 * This file handles all the communications between the users'
 * browsers, the networking processes, and users.js in the
 * main process.
 *
 * @license MIT license
 */

'use strict';

const cluster = require('cluster');
global.Config = require('./config/config');

function sendWorker(worker, message) {
	if (!worker.process.connected) {
		// worker crashed, exit instead of crashlooping
		console.trace("A worker process abruptly crashed.");
		console.log(Object.keys(worker));
		process.exit(1);
	}
	worker.send(message);
}

if (cluster.isMaster) {
	cluster.setupMaster({
		exec: require('path').resolve(__dirname, 'sockets.js'),
	});

	let workers = exports.workers = {};

	let spawnWorker = exports.spawnWorker = function () {
		let worker = cluster.fork({PSPORT: Config.port, PSBINDADDR: Config.bindaddress || '', PSNOSSL: Config.ssl ? 0 : 1});
		let id = worker.id;
		workers[id] = worker;
		worker.on('message', function (data) {
			// console.log('master received: ' + data);
			switch (data.charAt(0)) {
			case '*': {
				// *socketid, ip
				// connect
				let nlPos = data.indexOf('\n');
				Users.socketConnect(worker, id, data.substr(1, nlPos - 1), data.substr(nlPos + 1));
				break;
			}

			case '!': {
				// !socketid
				// disconnect
				Users.socketDisconnect(worker, id, data.substr(1));
				break;
			}

			case '<': {
				// <socketid, message
				// message
				let nlPos = data.indexOf('\n');
				Users.socketReceive(worker, id, data.substr(1, nlPos - 1), data.substr(nlPos + 1));
				break;
			}

			default:
			// unhandled
			}
		});
	};

	exports.listen = function (port, bindAddress, workerCount) {
		if (port !== undefined && !isNaN(port)) {
			Config.port = port;
			Config.ssl = null;
		} else {
			port = Config.port;
			// Autoconfigure the app when running in cloud hosting environments:
			try {
				let cloudenv = require('cloud-env');
				bindAddress = cloudenv.get('IP', bindAddress);
				port = cloudenv.get('PORT', port);
			} catch (e) {}
		}
		if (bindAddress !== undefined) {
			Config.bindaddress = bindAddress;
		}
		if (workerCount === undefined) {
			workerCount = (Config.workers !== undefined ? Config.workers : 1);
		}
		for (let i = 0; i < workerCount; i++) {
			spawnWorker();
		}
	};

	exports.killWorker = function (worker) {
		let idd = worker.id + '-';
		let count = 0;
		Users.connections.forEach(function (connection, connectionid) {
			if (connectionid.substr(idd.length) === idd) {
				Users.socketDisconnect(worker, worker.id, connection.socketid);
				count++;
			}
		});
		try {
			worker.kill();
		} catch (e) {}
		delete workers[worker.id];
		return count;
	};

	exports.killPid = function (pid) {
		pid = '' + pid;
		for (let id in workers) {
			let worker = workers[id];
			if (pid === '' + worker.process.pid) {
				return this.killWorker(worker);
			}
		}
		return false;
	};

	exports.socketSend = function (worker, socketid, message) {
		sendWorker(worker, '>' + socketid + '\n' + message);
	};
	exports.socketDisconnect = function (worker, socketid) {
		sendWorker(worker, '!' + socketid);
	};

	exports.channelBroadcast = function (channelid, message) {
		for (let workerid in workers) {
			sendWorker(workers[workerid], '#' + channelid + '\n' + message);
		}
	};
	exports.channelSend = function (worker, channelid, message) {
		sendWorker(worker, '#' + channelid + '\n' + message);
	};
	exports.channelAdd = function (worker, channelid, socketid) {
		sendWorker(worker, '+' + channelid + '\n' + socketid);
	};
	exports.channelRemove = function (worker, channelid, socketid) {
		sendWorker(worker, '-' + channelid + '\n' + socketid);
	};

	exports.subchannelBroadcast = function (channelid, message) {
		for (let workerid in workers) {
			sendWorker(workers[workerid], ':' + channelid + '\n' + message);
		}
	};
	exports.subchannelMove = function (worker, channelid, subchannelid, socketid) {
		sendWorker(worker, '.' + channelid + '\n' + subchannelid + '\n' + socketid);
	};
} else {
	// is worker

	if (process.env.PSPORT) Config.port = +process.env.PSPORT;
	if (process.env.PSBINDADDR) Config.bindaddress = process.env.PSBINDADDR;
	if (+process.env.PSNOSSL) Config.ssl = null;

	// ofe is optional
	// if installed, it will heap dump if the process runs out of memory
	try {
		require('ofe').call();
	} catch (e) {}

	// Static HTTP server

	// This handles the custom CSS and custom avatar features, and also
	// redirects yourserver:8001 to yourserver-8001.psim.us

	// It's optional if you don't need these features.

	global.Cidr = require('./cidr');

	if (Config.crashguard) {
		// graceful crash
		process.on('uncaughtException', function (err) {
			require('./crashlogger.js')(err, 'Socket process ' + cluster.worker.id + ' (' + process.pid + ')', true);
		});
	}

	let app = require('http').createServer();
	let appssl;
	if (Config.ssl) {
		appssl = require('https').createServer(Config.ssl.options);
	}
	try {
		(function () {
			let nodestatic = require('node-static');
			let cssserver = new nodestatic.Server('./config');
			let avatarserver = new nodestatic.Server('./config/avatars');
			let staticserver = new nodestatic.Server('./static');
			let staticRequestHandler = function (request, response) {
				// console.log("static rq: " + request.socket.remoteAddress + ":" + request.socket.remotePort + " -> " + request.socket.localAddress + ":" + request.socket.localPort + " - " + request.method + " " + request.url + " " + request.httpVersion + " - " + request.rawHeaders.join('|'));
				request.resume();
				request.addListener('end', function () {
					if (Config.customhttpresponse &&
							Config.customhttpresponse(request, response)) {
						return;
					}
					let server;
					if (request.url === '/custom.css') {
						server = cssserver;
					} else if (request.url.substr(0, 9) === '/avatars/') {
						request.url = request.url.substr(8);
						server = avatarserver;
					} else {
						if (/^\/([A-Za-z0-9][A-Za-z0-9-]*)\/?$/.test(request.url)) {
							request.url = '/';
						}
						server = staticserver;
					}
					server.serve(request, response, function (e, res) {
						if (e && (e.status === 404)) {
							staticserver.serveFile('404.html', 404, {}, request, response);
						}
					});
				});
			};
			app.on('request', staticRequestHandler);
			if (appssl) {
				appssl.on('request', staticRequestHandler);
			}
		})();
	} catch (e) {
		console.log('Could not start node-static - try `npm install` if you want to use it');
	}

	// SockJS server

	// This is the main server that handles users connecting to our server
	// and doing things on our server.

	let sockjs = require('sockjs');

	let server = sockjs.createServer({
		sockjs_url: "//play.pokemonshowdown.com/js/lib/sockjs-0.3.min.js",
		log: function (severity, message) {
			if (severity === 'error') console.log('ERROR: ' + message);
		},
		prefix: '/showdown',
		websocket: !Config.disablewebsocket,
	});

	let sockets = {};
	let channels = {};
	let subchannels = {};

	// Deal with phantom connections.
	let sweepClosedSockets = function () {
		for (let s in sockets) {
			if (sockets[s].protocol === 'xhr-streaming' &&
				sockets[s]._session &&
				sockets[s]._session.recv) {
				sockets[s]._session.recv.didClose();
			}

			// A ghost connection's `_session.to_tref._idlePrev` (and `_idleNext`) property is `null` while
			// it is an object for normal users. Under normal circumstances, those properties should only be
			// `null` when the timeout has already been called, but somehow it's not happening for some connections.
			// Simply calling `_session.timeout_cb` (the function bound to the aformentioned timeout) manually
			// on those connections kills those connections. For a bit of background, this timeout is the timeout
			// that sockjs sets to wait for users to reconnect within that time to continue their session.
			if (sockets[s]._session &&
				sockets[s]._session.to_tref &&
				!sockets[s]._session.to_tref._idlePrev) {
				sockets[s]._session.timeout_cb();
			}
		}
	};
	let interval = setInterval(sweepClosedSockets, 1000 * 60 * 10); // eslint-disable-line no-unused-vars

	process.on('message', function (data) {
		// console.log('worker received: ' + data);
		let socket = null, socketid = '';
		let channel = null, channelid = '';
		let subchannel = null, subchannelid = '';

		switch (data.charAt(0)) {
		case '$': // $code
			eval(data.substr(1));
			break;

		case '!': // !socketid
			// destroy
			socketid = data.substr(1);
			socket = sockets[socketid];
			if (!socket) return;
			socket.end();
			// After sending the FIN packet, we make sure the I/O is totally blocked for this socket
			socket.destroy();
			delete sockets[socketid];
			for (channelid in channels) {
				delete channels[channelid][socketid];
			}
			break;

		case '>': {
			// >socketid, message
			// message
			let nlLoc = data.indexOf('\n');
			socket = sockets[data.substr(1, nlLoc - 1)];
			if (!socket) return;
			socket.write(data.substr(nlLoc + 1));
			break;
		}

		case '#': {
			// #channelid, message
			// message to channel
			let nlLoc = data.indexOf('\n');
			channel = channels[data.substr(1, nlLoc - 1)];
			let message = data.substr(nlLoc + 1);
			for (socketid in channel) {
				channel[socketid].write(message);
			}
			break;
		}

		case '+': {
			// +channelid, socketid
			// add to channel
			let nlLoc = data.indexOf('\n');
			socketid = data.substr(nlLoc + 1);
			socket = sockets[socketid];
			if (!socket) return;
			channelid = data.substr(1, nlLoc - 1);
			channel = channels[channelid];
			if (!channel) channel = channels[channelid] = Object.create(null);
			channel[socketid] = socket;
			break;
		}

		case '-': {
			// -channelid, socketid
			// remove from channel
			let nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			channel = channels[channelid];
			if (!channel) return;
			socketid = data.slice(nlLoc + 1);
			delete channel[socketid];
			if (subchannels[channelid]) delete subchannels[channelid][socketid];
			let isEmpty = true;
			for (let socketid in channel) { // eslint-disable-line no-unused-vars
				isEmpty = false;
				break;
			}
			if (isEmpty) {
				delete channels[channelid];
				delete subchannels[channelid];
			}
			break;
		}

		case '.': {
			// .channelid, subchannelid, socketid
			// move subchannel
			let nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			let nlLoc2 = data.indexOf('\n', nlLoc + 1);
			subchannelid = data.slice(nlLoc + 1, nlLoc2);
			socketid = data.slice(nlLoc2 + 1);

			subchannel = subchannels[channelid];
			if (!subchannel) subchannel = subchannels[channelid] = Object.create(null);
			if (subchannelid === '0') {
				delete subchannel[socketid];
			} else {
				subchannel[socketid] = subchannelid;
			}
			break;
		}

		case ':': {
			// :channelid, message
			// message to subchannel
			let nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			channel = channels[channelid];
			subchannel = subchannels[channelid];
			let message = data.substr(nlLoc + 1);
			let messages = [null, null, null];
			for (socketid in channel) {
				switch (subchannel ? subchannel[socketid] : '0') {
				case '1':
					if (!messages[1]) {
						messages[1] = message.replace(/\n\|split\n[^\n]*\n([^\n]*)\n[^\n]*\n[^\n]*/g, '\n$1');
					}
					channel[socketid].write(messages[1]);
					break;
				case '2':
					if (!messages[2]) {
						messages[2] = message.replace(/\n\|split\n[^\n]*\n[^\n]*\n([^\n]*)\n[^\n]*/g, '\n$1');
					}
					channel[socketid].write(messages[2]);
					break;
				default:
					if (!messages[0]) {
						messages[0] = message.replace(/\n\|split\n([^\n]*)\n[^\n]*\n[^\n]*\n[^\n]*/g, '\n$1');
					}
					channel[socketid].write(messages[0]);
					break;
				}
			}
			break;
		}

		default:
		}
	});

	process.on('disconnect', function () {
		process.exit();
	});

	// this is global so it can be hotpatched if necessary
	let isTrustedProxyIp = Cidr.checker(Config.proxyip);
	let socketCounter = 0;
	server.on('connection', function (socket) {
		if (!socket) {
			// For reasons that are not entirely clear, SockJS sometimes triggers
			// this event with a null `socket` argument.
			return;
		} else if (!socket.remoteAddress) {
			// This condition occurs several times per day. It may be a SockJS bug.
			try {
				socket.end();
			} catch (e) {}
			return;
		}
		let socketid = socket.id = (++socketCounter);

		sockets[socket.id] = socket;

		if (isTrustedProxyIp(socket.remoteAddress)) {
			let ips = (socket.headers['x-forwarded-for'] || '').split(',');
			let ip;
			while ((ip = ips.pop())) {
				ip = ip.trim();
				if (!isTrustedProxyIp(ip)) {
					socket.remoteAddress = ip;
					break;
				}
			}
		}

		process.send('*' + socketid + '\n' + socket.remoteAddress);

		socket.on('data', function (message) {
			// drop empty messages (DDoS?)
			if (!message) return;
			// drop legacy JSON messages
			if (typeof message !== 'string' || message.charAt(0) === '{') return;
			// drop blank messages (DDoS?)
			let pipeIndex = message.indexOf('|');
			if (pipeIndex < 0 || pipeIndex === message.length - 1) return;

			process.send('<' + socketid + '\n' + message);
		});

		socket.on('close', function () {
			process.send('!' + socketid);
			delete sockets[socketid];
			for (let channelid in channels) {
				delete channels[channelid][socketid];
			}
		});
	});
	server.installHandlers(app, {});
	if (!Config.bindaddress) Config.bindaddress = '0.0.0.0';
	app.listen(Config.port, Config.bindaddress);
	console.log('Worker ' + cluster.worker.id + ' now listening on ' + Config.bindaddress + ':' + Config.port);

	if (appssl) {
		server.installHandlers(appssl, {});
		appssl.listen(Config.ssl.port, Config.bindaddress);
		console.log('Worker ' + cluster.worker.id + ' now listening for SSL on port ' + Config.ssl.port);
	}

	console.log('Test your server at http://' + (Config.bindaddress === '0.0.0.0' ? 'localhost' : Config.bindaddress) + ':' + Config.port);

	require('./repl.js').start('sockets-', cluster.worker.id + '-' + process.pid, function (cmd) { return eval(cmd); });
}
