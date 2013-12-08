/**
 * @fileoverview Session
 */

/**
 * @augments JsSIP
 * @class Invite Session
 */
(function(JsSIP) {

// Load dependencies
var Request         = @@include('../src/RTCSession/Request.js')
var RTCMediaHandler = @@include('../src/RTCSession/RTCMediaHandler.js')
var DTMF            = @@include('../src/RTCSession/DTMF.js')

var RTCSession,
  C = {
    // RTCSession states
    STATUS_NULL:               0,
    STATUS_INVITE_SENT:        1,
    STATUS_1XX_RECEIVED:       2,
    STATUS_INVITE_RECEIVED:    3,
    STATUS_WAITING_FOR_ANSWER: 4,
    STATUS_ANSWERED:           5,
    STATUS_WAITING_FOR_ACK:    6,
    STATUS_CANCELED:           7,
    STATUS_TERMINATED:         8,
    STATUS_CONFIRMED:          9
  };


RTCSession = function(ua) {
  var events = [
  'connecting',
  'progress',
  'failed',
  'started',
  'ended',
  'newDTMF'
  ];

  this.ua = ua;
  this.status = C.STATUS_NULL;
  this.dialog = null;
  this.earlyDialogs = {};
  this.rtcMediaHandler = null;

  // Session Timers
  this.timers = {
    ackTimer: null,
    expiresTimer: null,
    invite2xxTimer: null,
    userNoAnswerTimer: null
  };

  // Session info
  this.direction = null;
  this.local_identity = null;
  this.remote_identity = null;
  this.start_time = null;
  this.end_time = null;
  this.tones = null;

  // Custom session empty object for high level use
  this.data = {};

  this.initEvents(events);
};
RTCSession.prototype = new JsSIP.EventEmitter();


/**
 * User API
 */

/**
 * Terminate the call.
 * @param {Object} [options]
 */
RTCSession.prototype.terminate = function(options) {
  options = options || {};

  var cancel_reason, dialog,
    cause = options.cause || JsSIP.C.causes.BYE,
    status_code = options.status_code,
    reason_phrase = options.reason_phrase,
    extraHeaders = options.extraHeaders || [],
    body = options.body,
    self = this;

  // Check Session Status
  if (this.status === C.STATUS_TERMINATED) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  switch(this.status) {
    // - UAC -
    case C.STATUS_NULL:
    case C.STATUS_INVITE_SENT:
    case C.STATUS_1XX_RECEIVED:
      this.logger.log('canceling RTCSession');

      if (status_code && (status_code < 200 || status_code >= 700)) {
        throw new TypeError('Invalid status_code: '+ status_code);
      } else if (status_code) {
        reason_phrase = reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
        cancel_reason = 'SIP ;cause=' + status_code + ' ;text="' + reason_phrase + '"';
      }

      // Check Session Status
      if (this.status === C.STATUS_NULL) {
        this.isCanceled = true;
        this.cancelReason = cancel_reason;
      } else if (this.status === C.STATUS_INVITE_SENT) {
        if(this.received_100) {
          this.request.cancel(cancel_reason);
        } else {
          this.isCanceled = true;
          this.cancelReason = cancel_reason;
        }
      } else if(this.status === C.STATUS_1XX_RECEIVED) {
        this.request.cancel(cancel_reason);
      }

      this.failed('local', null, JsSIP.C.causes.CANCELED);
      break;

      // - UAS -
    case C.STATUS_WAITING_FOR_ANSWER:
    case C.STATUS_ANSWERED:
      this.logger.log('rejecting RTCSession');

      status_code = status_code || 480;

      if (status_code < 300 || status_code >= 700) {
        throw new TypeError('Invalid status_code: '+ status_code);
      }

      this.request.reply(status_code, reason_phrase, extraHeaders, body);
      this.failed('local', null, JsSIP.C.causes.REJECTED);
      break;
      
    case C.STATUS_WAITING_FOR_ACK:
    case C.STATUS_CONFIRMED:
      this.logger.log('terminating RTCSession');

      reason_phrase = options.reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';

      if (status_code && (status_code < 200 || status_code >= 700)) {
        throw new TypeError('Invalid status_code: '+ status_code);
      } else if (status_code) {
        extraHeaders.push('Reason: SIP ;cause=' + status_code + '; text="' + reason_phrase + '"');
      }
      
      /* RFC 3261 section 15 (Terminating a session):
        *
        * "...the callee's UA MUST NOT send a BYE on a confirmed dialog
        * until it has received an ACK for its 2xx response or until the server
        * transaction times out."
        */
      if (this.status === C.STATUS_WAITING_FOR_ACK &&
          this.direction === 'incoming' &&
          this.request.server_transaction.state !== JsSIP.Transactions.C.STATUS_TERMINATED) {

        // Save the dialog for later restoration
        dialog = this.dialog;
        
        // Send the BYE as soon as the ACK is received...
        this.receiveRequest = function(request) {
          if(request.method === JsSIP.C.ACK) {
            this.sendRequest(JsSIP.C.BYE, {
              extraHeaders: extraHeaders,
              body: body
            });
            dialog.terminate();
          }
        };
        
        // .., or when the INVITE transaction times out 
        this.request.server_transaction.on('stateChanged', function(e){
          if (e.sender.state === JsSIP.Transactions.C.STATUS_TERMINATED) {
            self.sendRequest(JsSIP.C.BYE, {
              extraHeaders: extraHeaders,
              body: body
            });
            dialog.terminate();
          }
        });

        this.ended('local', null, cause);
        
        // Restore the dialog into 'this' in order to be able to send the in-dialog BYE :-)
        this.dialog = dialog;
        
        // Restore the dialog into 'ua' so the ACK can reach 'this' session
        this.ua.dialogs[dialog.id.toString()] = dialog;
        
      } else {
        this.sendRequest(JsSIP.C.BYE, {
          extraHeaders: extraHeaders,
          body: body
        });

        this.ended('local', null, cause);
      }
  }

  this.close();
};

/**
 * Answer the call.
 * @param {Object} [options]
 */
RTCSession.prototype.answer = function(options) {
  options = options || {};

  var
    self = this,
    request = this.request,
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {'audio':true, 'video':true},
    mediaStream = options.mediaStream || null,

    // User media succeeded
    userMediaSucceeded = function(stream) {
      self.rtcMediaHandler.addStream(
        stream,
        streamAdditionSucceeded,
        streamAdditionFailed
      );
    },

    // User media failed
    userMediaFailed = function() {
      request.reply(480);
      self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
    },

    // rtcMediaHandler.addStream successfully added
    streamAdditionSucceeded = function() {
      self.connecting(request);
      
      if (self.status === C.STATUS_TERMINATED) {
        return;
      }
      
      self.rtcMediaHandler.createAnswer(
        answerCreationSucceeded,
        answerCreationFailed
      );
    },

    // rtcMediaHandler.addStream failed
    streamAdditionFailed = function() {
      if (self.status === C.STATUS_TERMINATED) {
        return;
      }

      self.failed('system', null, JsSIP.C.causes.WEBRTC_ERROR);
    },

    // rtcMediaHandler.createAnswer succeeded
    answerCreationSucceeded = function(body) {
      var
        // run for reply success callback
        replySucceeded = function() {
          var timeout = JsSIP.Timers.T1;

          self.status = C.STATUS_WAITING_FOR_ACK;

          /**
           * RFC3261 13.3.1.4
           * Response retransmissions cannot be accomplished by transaction layer
           *  since it is destroyed when receiving the first 2xx answer
           */
          self.timers.invite2xxTimer = window.setTimeout(function invite2xxRetransmission() {
              if (self.status !== C.STATUS_WAITING_FOR_ACK) {
                return;
              }

              request.reply(200, null, extraHeaders, body);

              if (timeout < JsSIP.Timers.T2) {
                timeout = timeout * 2;
                if (timeout > JsSIP.Timers.T2) {
                  timeout = JsSIP.Timers.T2;
                }
              }
              self.timers.invite2xxTimer = window.setTimeout(
                invite2xxRetransmission, timeout
              );
            },
            timeout
          );

          /**
           * RFC3261 14.2
           * If a UAS generates a 2xx response and never receives an ACK,
           *  it SHOULD generate a BYE to terminate the dialog.
           */
          self.timers.ackTimer = window.setTimeout(function() {
              if(self.status === C.STATUS_WAITING_FOR_ACK) {
                self.logger.log('no ACK received, terminating the call');
                window.clearTimeout(self.timers.invite2xxTimer);
                self.sendRequest(JsSIP.C.BYE);
                self.ended('remote', null, JsSIP.C.causes.NO_ACK);
              }
            },
            JsSIP.Timers.TIMER_H
          );

          self.started('local');
        },

        // run for reply failure callback
        replyFailed = function() {
          self.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
        };

      request.reply(200, null, extraHeaders,
        body,
        replySucceeded,
        replyFailed
      );
    },

    // rtcMediaHandler.createAnsewr failed
    answerCreationFailed = function() {
      if (self.status === C.STATUS_TERMINATED) {
        return;
      }

      self.failed('system', null, JsSIP.C.causes.WEBRTC_ERROR);
    };


  // Check Session Direction and Status
  if (this.direction !== 'incoming') {
    throw new JsSIP.Exceptions.NotSupportedError('"answer" not supported for outgoing RTCSession');
  } else if (this.status !== C.STATUS_WAITING_FOR_ANSWER) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }
  
  this.status = C.STATUS_ANSWERED;

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS')) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  window.clearTimeout(this.timers.userNoAnswerTimer);
  
  extraHeaders.unshift('Contact: ' + self.contact);

  if (mediaStream) {
    userMediaSucceeded(mediaStream);
  } else {
    this.rtcMediaHandler.getUserMedia(
      userMediaSucceeded,
      userMediaFailed,
      mediaConstraints
    );
  }
};

/**
 * Send a DTMF
 *
 * @param {String|Number} tones
 * @param {Object} [options]
 */
RTCSession.prototype.sendDTMF = function(tones, options) {
  var duration, interToneGap,
    position = 0,
    self = this;

  options = options || {};
  duration = options.duration || null;
  interToneGap = options.interToneGap || null;

  if (tones === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check Session Status
  if (this.status !== C.STATUS_CONFIRMED && this.status !== C.STATUS_WAITING_FOR_ACK) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Check tones
  if (!tones || (typeof tones !== 'string' && typeof tones !== 'number') || !tones.toString().match(/^[0-9A-D#*,]+$/i)) {
    throw new TypeError('Invalid tones: '+ tones);
  }

  tones = tones.toString();

  // Check duration
  if (duration && !JsSIP.Utils.isDecimal(duration)) {
    throw new TypeError('Invalid tone duration: '+ duration);
  } else if (!duration) {
    duration = DTMF.C.DEFAULT_DURATION;
  } else if (duration < DTMF.C.MIN_DURATION) {
    this.logger.warn('"duration" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_DURATION+ ' milliseconds');
    duration = DTMF.C.MIN_DURATION;
  } else if (duration > DTMF.C.MAX_DURATION) {
    this.logger.warn('"duration" value is greater than the maximum allowed, setting it to '+ DTMF.C.MAX_DURATION +' milliseconds');
    duration = DTMF.C.MAX_DURATION;
  } else {
    duration = Math.abs(duration);
  }
  options.duration = duration;

  // Check interToneGap
  if (interToneGap && !JsSIP.Utils.isDecimal(interToneGap)) {
    throw new TypeError('Invalid interToneGap: '+ interToneGap);
  } else if (!interToneGap) {
    interToneGap = DTMF.C.DEFAULT_INTER_TONE_GAP;
  } else if (interToneGap < DTMF.C.MIN_INTER_TONE_GAP) {
    this.logger.warn('"interToneGap" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_INTER_TONE_GAP +' milliseconds');
    interToneGap = DTMF.C.MIN_INTER_TONE_GAP;
  } else {
    interToneGap = Math.abs(interToneGap);
  }

  if (this.tones) {
    // Tones are already queued, just add to the queue
    this.tones += tones;
    return;
  }

  // New set of tones to start sending
  this.tones = tones;

  var sendDTMF = function () {
    var tone, timeout,
      tones = self.tones;

    if (self.status === C.STATUS_TERMINATED || !tones || position >= tones.length) {
      // Stop sending DTMF
      self.tones = null;
      return;
    }

    tone = tones[position];
    position += 1;

    if (tone === ',') {
      timeout = 2000;
    } else {
      var dtmf = new DTMF(self);
      dtmf.on('failed', function(){self.tones = null;});
      dtmf.send(tone, options);
      timeout = duration + interToneGap;
    }

    // Set timeout for the next tone
    window.setTimeout(sendDTMF, timeout);
  };

  // Send the first tone
  sendDTMF();
};

/**
 * Send a generic in-dialog Request
 *
 * @param {String} method
 * @param {Object} [options]
 */
RTCSession.prototype.sendRequest = function(method, options) {
  var request = new Request(this);

  request.send(method, options);
};


/**
 * RTCPeerconnection handlers
 */
RTCSession.prototype.getLocalStreams = function() {
  return this.rtcMediaHandler &&
    this.rtcMediaHandler.peerConnection &&
    this.rtcMediaHandler.peerConnection.getLocalStreams() || [];
};

RTCSession.prototype.getRemoteStreams = function() {
  return this.rtcMediaHandler &&
    this.rtcMediaHandler.peerConnection &&
    this.rtcMediaHandler.peerConnection.getRemoteStreams() || [];
};


/**
 * Session Management
 */

/**
* @private
*/
RTCSession.prototype.init_incoming = function(request) {
  var expires,
    self = this,
    contentType = request.getHeader('Content-Type');

  // Check body and content type
  if(!request.body || (contentType !== 'application/sdp')) {
    request.reply(415);
    return;
  }

  // Session parameter initialization
  this.status = C.STATUS_INVITE_RECEIVED;
  this.from_tag = request.from_tag;
  this.id = request.call_id + this.from_tag;
  this.request = request;
  this.contact = this.ua.contact.toString();

  this.logger = this.ua.getLogger('jssip.rtcsession', this.id);

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  //Get the Expires header value if exists
  if(request.hasHeader('expires')) {
    expires = request.getHeader('expires') * 1000;
  }

  /* Set the to_tag before
   * replying a response code that will create a dialog.
   */
  request.to_tag = JsSIP.Utils.newTag();

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS', true)) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  //Initialize Media Session
  this.rtcMediaHandler = new RTCMediaHandler(this,
    {"optional": [{'DtlsSrtpKeyAgreement': 'true'}]}
  );
  this.rtcMediaHandler.onMessage(
    'offer',
    request.body,
    /*
     * onSuccess
     * SDP Offer is valid. Fire UA newRTCSession
     */
    function() {
      request.reply(180, null, ['Contact: ' + self.contact]);
      self.status = C.STATUS_WAITING_FOR_ANSWER;

      // Set userNoAnswerTimer
      self.timers.userNoAnswerTimer = window.setTimeout(function() {
          request.reply(408);
          self.failed('local',null, JsSIP.C.causes.NO_ANSWER);
        }, self.ua.configuration.no_answer_timeout
      );

      /* Set expiresTimer
       * RFC3261 13.3.1
       */
      if (expires) {
        self.timers.expiresTimer = window.setTimeout(function() {
            if(self.status === C.STATUS_WAITING_FOR_ANSWER) {
              request.reply(487);
              self.failed('system', null, JsSIP.C.causes.EXPIRES);
            }
          }, expires
        );
      }

      self.newRTCSession('remote', request);
    },
    /*
     * onFailure
     * Bad media description
     */
    function(e) {
      self.logger.warn('invalid SDP');
      self.logger.warn(e);
      request.reply(488);
    }
  );
};

/**
 * @private
 */
RTCSession.prototype.connect = function(target, options) {
  options = options || {};

  var event, requestParams,
    originalTarget = target,
    eventHandlers = options.eventHandlers || {},
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {audio: true, video: true},
    mediaStream = options.mediaStream || null,
    RTCConstraints = options.RTCConstraints || {};

  if (target === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check WebRTC support
  if (!JsSIP.WebRTC.isSupported) {
    throw new JsSIP.Exceptions.NotSupportedError('WebRTC not supported');
  }

  // Check target validity
  target = this.ua.normalizeTarget(target);
  if (!target) {
    throw new TypeError('Invalid target: '+ originalTarget);
  }

  // Check Session Status
  if (this.status !== C.STATUS_NULL) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Set event handlers
  for (event in eventHandlers) {
    this.on(event, eventHandlers[event]);
  }

  // Session parameter initialization
  this.from_tag = JsSIP.Utils.newTag();

  // Set anonymous property
  this.anonymous = options.anonymous || false;

  // OutgoingSession specific parameters
  this.isCanceled = false;
  this.received_100 = false;

  requestParams = {from_tag: this.from_tag};

  /* Do not add ;ob in initial forming dialog requests if the registration over the current
   * connection got a GRUU URI.
   */
  this.contact = this.ua.contact.toString({
    anonymous: this.anonymous,
    outbound: ((this.anonymous === false && this.ua.contact.pub_gruu) || (this.anonymous === true && this.ua.contact.temp_gruu)) ? false : true
  });

  if (this.anonymous) {
    requestParams.from_display_name = 'Anonymous';
    requestParams.from_uri = 'sip:anonymous@anonymous.invalid';

    extraHeaders.push('P-Preferred-Identity: '+ this.ua.configuration.uri.toString());
    extraHeaders.push('Privacy: id');
  }

  extraHeaders.push('Contact: '+ this.contact);
  extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(this.ua));
  extraHeaders.push('Content-Type: application/sdp');

  this.request = new JsSIP.OutgoingRequest(JsSIP.C.INVITE, target, this.ua, requestParams, extraHeaders);

  this.id = this.request.call_id + this.from_tag;

  this.logger = this.ua.getLogger('jssip.rtcsession', this.id);

  this.rtcMediaHandler = new RTCMediaHandler(this, RTCConstraints);

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  this.newRTCSession('local', this.request);

  this.sendInitialRequest(mediaConstraints, mediaStream);
};

/**
* @private
*/
RTCSession.prototype.close = function() {
  var idx;

  if(this.status === C.STATUS_TERMINATED) {
    return;
  }

  this.logger.log('closing INVITE session ' + this.id);

  // 1st Step. Terminate media.
  if (this.rtcMediaHandler){
    this.rtcMediaHandler.close();
  }

  // 2nd Step. Terminate signaling.

  // Clear session timers
  for(idx in this.timers) {
    window.clearTimeout(this.timers[idx]);
  }

  // Terminate dialogs

  // Terminate confirmed dialog
  if(this.dialog) {
    this.dialog.terminate();
    delete this.dialog;
  }

  // Terminate early dialogs
  for(idx in this.earlyDialogs) {
    this.earlyDialogs[idx].terminate();
    delete this.earlyDialogs[idx];
  }

  this.status = C.STATUS_TERMINATED;

  delete this.ua.sessions[this.id];
};

/**
 * Dialog Management
 * @private
 */
RTCSession.prototype.createDialog = function(message, type, early) {
  var dialog, early_dialog,
    local_tag = (type === 'UAS') ? message.to_tag : message.from_tag,
    remote_tag = (type === 'UAS') ? message.from_tag : message.to_tag,
    id = message.call_id + local_tag + remote_tag;

    early_dialog = this.earlyDialogs[id];

  // Early Dialog
  if (early) {
    if (early_dialog) {
      return true;
    } else {
      early_dialog = new JsSIP.Dialog(this, message, type, JsSIP.Dialog.C.STATUS_EARLY);

      // Dialog has been successfully created.
      if(early_dialog.error) {
        this.logger.error(dialog.error);
        this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
        return false;
      } else {
        this.earlyDialogs[id] = early_dialog;
        return true;
      }
    }
  }

  // Confirmed Dialog
  else {
    // In case the dialog is in _early_ state, update it
    if (early_dialog) {
      early_dialog.update(message, type);
      this.dialog = early_dialog;
      delete this.earlyDialogs[id];
      return true;
    }

    // Otherwise, create a _confirmed_ dialog
    dialog = new JsSIP.Dialog(this, message, type);

    if(dialog.error) {
      this.logger.error(dialog.error);
      this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
      return false;
    } else {
      this.to_tag = message.to_tag;
      this.dialog = dialog;
      return true;
    }
  }
};


/**
 * In dialog Request Reception
 * @private
 */
RTCSession.prototype.receiveRequest = function(request) {
  var contentType;

  if(request.method === JsSIP.C.CANCEL) {
    /* RFC3261 15 States that a UAS may have accepted an invitation while a CANCEL
    * was in progress and that the UAC MAY continue with the session established by
    * any 2xx response, or MAY terminate with BYE. JsSIP does continue with the
    * established session. So the CANCEL is processed only if the session is not yet
    * established.
    */

    /*
    * Terminate the whole session in case the user didn't accept nor reject the
    *request opening the session.
    */
    if(this.status === C.STATUS_WAITING_FOR_ANSWER) {
      this.status = C.STATUS_CANCELED;
      this.request.reply(487);
      this.failed('remote', request, JsSIP.C.causes.CANCELED);
    }
  } else {
    // Requests arriving here are in-dialog requests.
    switch(request.method) {
      case JsSIP.C.ACK:
        if(this.status === C.STATUS_WAITING_FOR_ACK) {
          window.clearTimeout(this.timers.ackTimer);
          window.clearTimeout(this.timers.invite2xxTimer);
          this.status = C.STATUS_CONFIRMED;
        }
        break;
      case JsSIP.C.BYE:
        if(this.status === C.STATUS_CONFIRMED) {
          request.reply(200);
          this.ended('remote', request, JsSIP.C.causes.BYE);
        }
        break;
      case JsSIP.C.INVITE:
        if(this.status === C.STATUS_CONFIRMED) {
          this.logger.log('re-INVITE received');
        }
        break;
      case JsSIP.C.INFO:
        if(this.status === C.STATUS_CONFIRMED || this.status === C.STATUS_WAITING_FOR_ACK) {
          contentType = request.getHeader('content-type');
          if (contentType && (contentType.match(/^application\/dtmf-relay/i))) {
            new DTMF(this).init_incoming(request);
          }
        }
    }
  }
};


/**
 * Initial Request Sender
 * @private
 */
RTCSession.prototype.sendInitialRequest = function(constraints, mediaStream) {
  var
  self = this,
 request_sender = new JsSIP.RequestSender(self, this.ua),

 // User media succeeded
 userMediaSucceeded = function(stream) {
   self.rtcMediaHandler.addStream(
     stream,
     streamAdditionSucceeded,
     streamAdditionFailed
   );
 },

 // User media failed
 userMediaFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
 },

 // rtcMediaHandler.addStream successfully added
 streamAdditionSucceeded = function() {
   self.connecting(self.request);
   
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }
      
   self.rtcMediaHandler.createOffer(
     offerCreationSucceeded,
     offerCreationFailed
   );
 },

 // rtcMediaHandler.addStream failed
 streamAdditionFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('system', null, JsSIP.C.causes.WEBRTC_ERROR);
 },

 // rtcMediaHandler.createOffer succeeded
 offerCreationSucceeded = function(offer) {
   if (self.isCanceled || self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.request.body = offer;
   self.status = C.STATUS_INVITE_SENT;
   request_sender.send();
 },

 // rtcMediaHandler.createOffer failed
 offerCreationFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('system', null, JsSIP.C.causes.WEBRTC_ERROR);
 };

 if (mediaStream) {
   userMediaSucceeded(mediaStream);
 } else {
   this.rtcMediaHandler.getUserMedia(
     userMediaSucceeded,
     userMediaFailed,
     constraints
   );
 }
};

/**
 * Reception of Response for Initial Request
 * @private
 */
RTCSession.prototype.receiveResponse = function(response) {
  var cause, dialog,
    session = this;

  // Handle 2XX retransmissions and responses from forked requests
  if (this.dialog && (response.status_code >=200 && response.status_code <=299)) {
  
    /*
     * If it is a retransmission from the endpoint that established
     * the dialog, send an ACK
     */
    if (this.dialog.id.call_id === response.call_id && 
        this.dialog.id.local_tag === response.from_tag && 
        this.dialog.id.remote_tag === response.to_tag) {
      this.sendRequest(JsSIP.C.ACK);
      return;
    } 
    
    // If not, send an ACK  and terminate
    else  {
      dialog = new JsSIP.Dialog(this, response, 'UAC');
      
      if (dialog.error !== undefined) {
        this.logger.error(dialog.error);
        return;
      }
      
      dialog.sendRequest({
          owner: {status: C.STATUS_TERMINATED},
          onRequestTimeout: function(){},
          onTransportError: function(){},
          onDialogError: function(){},
          receiveResponse: function(){}
        }, JsSIP.C.ACK);
        
      dialog.sendRequest({
          owner: {status: C.STATUS_TERMINATED},
          onRequestTimeout: function(){},
          onTransportError: function(){},
          onDialogError: function(){},
          receiveResponse: function(){}
        }, JsSIP.C.BYE);
      return;
    }

  } else if(this.status !== C.STATUS_INVITE_SENT && this.status !== C.STATUS_1XX_RECEIVED) {
    return;
  }

  // Proceed to cancellation if the user requested.
  if(this.isCanceled) {
    if(response.status_code >= 100 && response.status_code < 200) {
      this.request.cancel(this.cancelReason);
    } else if(response.status_code >= 200 && response.status_code < 299) {
      this.acceptAndTerminate(response);
    }
    return;
  }

  switch(true) {
    case /^100$/.test(response.status_code):
      this.received_100 = true;
      break;
    case /^1[0-9]{2}$/.test(response.status_code):
      // Do nothing with 1xx responses without To tag.
      if(!response.to_tag) {
        this.logger.warn('1xx response received without to tag');
        break;
      }

      // Create Early Dialog if 1XX comes with contact
      if(response.hasHeader('contact')) {
        // An error on dialog creation will fire 'failed' event
        this.createDialog(response, 'UAC', true);
      }

      this.status = C.STATUS_1XX_RECEIVED;
      this.progress('remote', response);
      break;
    case /^2[0-9]{2}$/.test(response.status_code):
      if(!response.body) {
        this.acceptAndTerminate(response, 400, 'Missing session description');
        this.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
        break;
      }

      // An error on dialog creation will fire 'failed' event
      if (!this.createDialog(response, 'UAC')) {
        break;
      }

      this.rtcMediaHandler.onMessage(
        'answer',
        response.body,
        /*
         * onSuccess
         * SDP Answer fits with Offer. Media will start
         */
        function() {
          session.status = C.STATUS_CONFIRMED;
          session.sendRequest(JsSIP.C.ACK);
          session.started('remote', response);
        },
        /*
         * onFailure
         * SDP Answer does not fit the Offer. Accept the call and Terminate.
         */
        function(e) {
          session.logger.warn(e);
          session.acceptAndTerminate(response, 488, 'Not Acceptable Here');
          session.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
        }
      );
      break;
    default:
      cause = JsSIP.Utils.sipErrorCause(response.status_code);
      this.failed('remote', response, cause);
  }
};


/**
* @private
*/
RTCSession.prototype.acceptAndTerminate = function(response, status_code, reason_phrase) {
  var extraHeaders = [];

  if (status_code) {
    reason_phrase = reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
    extraHeaders.push('Reason: SIP ;cause=' + status_code + '; text="' + reason_phrase + '"');
  }

  // An error on dialog creation will fire 'failed' event
  if (this.dialog || this.createDialog(response, 'UAC')) {
    this.sendRequest(JsSIP.C.ACK);
    this.sendRequest(JsSIP.C.BYE, {
      extraHeaders: extraHeaders
    });
  }
};


/**
 * Session Callbacks
 */

/**
* @private
*/
RTCSession.prototype.onTransportError = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    } else {
      this.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    }
  }
};

/**
* @private
*/
RTCSession.prototype.onRequestTimeout = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.REQUEST_TIMEOUT);
    } else {
      this.failed('system', null, JsSIP.C.causes.REQUEST_TIMEOUT);
    }
  }
};

/**
 * @private
 */
RTCSession.prototype.onDialogError = function(response) {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('remote', response, JsSIP.C.causes.DIALOG_ERROR);
    } else {
      this.failed('remote', response, JsSIP.C.causes.DIALOG_ERROR);
    }
  }
};

/**
 * Internal Callbacks
 */

/**
 * @private
 */
RTCSession.prototype.newRTCSession = function(originator, request) {
  var session = this,
    event_name = 'newRTCSession';

  if (originator === 'remote') {
    session.direction = 'incoming';
    session.local_identity = request.to;
    session.remote_identity = request.from;
  } else if (originator === 'local'){
    session.direction = 'outgoing';
    session.local_identity = request.from;
    session.remote_identity = request.to;
  }

  session.ua.emit(event_name, session.ua, {
    originator: originator,
    session: session,
    request: request
  });
};

/**
 * @private
 */
RTCSession.prototype.connecting = function(request) {
  var session = this,
  event_name = 'connecting';

  session.emit(event_name, session, {
    request: request
  });
};

/**
 * @private
 */
RTCSession.prototype.progress = function(originator, response) {
  var session = this,
    event_name = 'progress';

  session.emit(event_name, session, {
    originator: originator,
    response: response || null
  });
};

/**
 * @private
 */
RTCSession.prototype.started = function(originator, message) {
  var session = this,
    event_name = 'started';

  session.start_time = new Date();

  session.emit(event_name, session, {
    originator: originator,
    response: message || null
  });
};

/**
 * @private
 */
RTCSession.prototype.ended = function(originator, message, cause) {
  var session = this,
    event_name = 'ended';

  session.end_time = new Date();

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};

/**
 * @private
 */
RTCSession.prototype.failed = function(originator, message, cause) {
  var session = this,
    event_name = 'failed';

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};


RTCSession.C = C;
JsSIP.RTCSession = RTCSession;
}(JsSIP));
