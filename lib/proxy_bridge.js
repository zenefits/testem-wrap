var http = require('http');
var redis = require('redis');
var domain = require('domain');
var REDIS_CHANNEL_IN = 'testem-wrap-proxy-bridge-python-js';
var REDIS_CHANNEL_OUT = 'testem-wrap-proxy-bridge-js-python';

//If there are other urls for which octet-stream is a valid content type
//   add regular expressions for their urls here:
var OCTETSTREAM_URL_WHITELIST = [ /custom_api\/documents\/in_memory_s3\/([\w\-_]+)\/([\w\-_\/]+)/ ];
var MESSAGE_TYPES = [
  'cmd',
  'req',
  'result',
  'output'
];

var Bridge = function (channelUuid, apiUrl) {
  var inClient = redis.createClient();
  var outClient = redis.createClient();

  inClient.on('error', console.error);
  outClient.on('error', console.error);

  this.apiUrl = apiUrl;
  this.channelIn = [REDIS_CHANNEL_IN, channelUuid].join('-');
  this.channelOut = [REDIS_CHANNEL_OUT, channelUuid].join('-');
  this.server = http.createServer();
  this.retries = 0;
  this.inClient = inClient;
  this.outClient = outClient;
  this.currReqId = 0;
  this.inFlight = {};
};

Bridge.prototype = new (function () {

  var _expectBody = function (req) {

    var contentType = req.headers['content-type'] || '';
    // Buffer the body if needed
    var validOctetStream = OCTETSTREAM_URL_WHITELIST.some(function(re) {
        return re.test(req.url);
    });
    return (req.method == 'POST' || req.method == 'PUT') &&
      (
        contentType.indexOf('form-urlencoded') > -1 ||
        contentType.indexOf('application/json') > -1 ||
        (contentType.indexOf('application/octet-stream') > -1 && validOctetStream)
      );
  };

  this.start = function () {
    var server = this.server;
    var client = this.inClient;

    server.addListener('request', this.acceptRequest.bind(this));
    server.addListener('error', this.handleServerError.bind(this));

    this.startServer();

    client.subscribe(this.channelIn);
    client.on('message', this.handleInMessage.bind(this));
  };

  this.handleServerError = function (err) {
    if (err.code == 'EADDRINUSE') {
      this.retries++;
      if (this.retries > 6) {
        throw new Error('Could not bind the testem-wrap proxy server to the right port');
      }
      // Try restarting with exponential backoff -- 1, 2, 4, 8, 16, 32 seconds
      setTimeout(this.startServer.bind(this), Math.pow(2, this.retries) * 500);
    }
    else {
      throw new Error('Something went wrong starting the testem-wrap proxy server.');
    }
  };

  this.startServer = function () {
    this.server.listen(this.apiUrl.port, this.apiUrl.hostname);
  };

  this.acceptRequest = function (req, resp) {
    var self = this;
    var dmn = domain.create();
    var handle = this.handleRequest.bind(this);
    var body = '';

    dmn.on('error', function (err) {
      resp.writeHead(500, {'Content-Type': 'text/plain'});
      resp.write(err.message || 'Something went wrong');
      resp.end();
    });
    dmn.add(req);
    dmn.add(resp);

    dmn.run(function () {
      const id = self.currReqId++;

      // Buffer the body if needed
      if (_expectBody(req)) {
        // FIXME: Assumes the entire request body is in the buffer,
        // not streaming request
        req.addListener('readable', function (data) {
          var chunk;
          while ((chunk = req.read())) {
            body += chunk;
          }
        });

        req.addListener('end', function () {
          req.body = body;
          handle(req, resp, id);
        });
      }
      else {
        handle(req, resp, id);
      }
    });
  };

  this.handleRequest = function  (req, resp, id) {
    var req = {
      reqId: id,
      method: req.method,
      contentType: req.headers['content-type'],
      url: req.url,
      body: req.body || null,
      qs: req.url.split('?')[1] || null
    };
    var message = {
      type: 'req',
      data: req
    };
    this.inFlight['req' + id] = {
      req: req,
      resp: resp
    };

    this.sendReq(req);
  };

  this.handleInMessage = function (channel, messageJson) {
    var message = JSON.parse(messageJson);
    if (channel == this.channelIn) {
      var key = 'req' + message.reqId;
      var current = this.inFlight[key];
      delete this.inFlight[key];
      resp = current.resp;
      resp.writeHead(message.status_code, {'Content-Type': message.content_type});
      if (message.content.length) {
        resp.write(message.content);
      } else {
        resp.write("{}"); // default empty error content to get response object to parse properly
      }
      resp.end();
    }
  };

  this.stop = function () {
    this.server.close();
    this.inClient.end();
    this.outClient.end();
  };

  // Create API method for each message type
  // sendCmd, sendReq, sendOutput
  MESSAGE_TYPES.forEach(function (messageType) {
    this['send' + messageType.substr(0, 1).toUpperCase() +
         messageType.substr(1)] = function (data) {
      this.send(messageType, data);
    };
  }, this);

  this.send = function (messageType, data) {
    this.outClient.publish(this.channelOut, JSON.stringify({
      type: messageType,
      data: data
    }));
  };

})();

exports.Bridge = Bridge;
