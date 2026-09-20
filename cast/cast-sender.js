/* Stadium Slugger Cage Edition — Cast sender module.
 *
 * Sends session + swing updates to the cage display (cast/receiver.html)
 * running on the TV via Chromecast. Web sender using the Cast CAF sender SDK.
 *
 * Usage in the session page:
 *   <script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
 *   <script src="cast/cast-sender.js"></script>
 *   <script>
 *     CageCast.init({ appId: 'ABCD1234', button: document.getElementById('cast-btn') });
 *     // when a swing is measured:
 *     CageCast.swing({ n: 3, exitVeloMph: 87.2, launchAngleDeg: 24, at: '7:42 PM' });
 *     // session state changes:
 *     CageCast.session('live');
 *   </script>
 *
 * Notes:
 * - The page must be served over HTTPS (GitHub Pages qualifies).
 * - The cast button works in Chrome. Other Chromium browsers vary; if the
 *   button never finds the TV, use Chrome on the phone.
 * - Phone and TV must be on the same Wi-Fi network.
 * - Get the App ID by registering the receiver in the Google Cast SDK
 *   Developer Console (see cast/README.md).
 */
var CageCast = (function () {
  'use strict';

  var NAMESPACE = 'urn:x-cast:com.stadiumslugger.cage';

  var appId = null;
  var button = null;
  var castContext = null;
  var connected = false;
  var onStateChange = null;

  function log() {
    if (window.console && console.log) {
      console.log.apply(console, ['[CageCast]'].concat([].slice.call(arguments)));
    }
  }

  function setConnected(v) {
    if (connected === v) return;
    connected = v;
    if (button) {
      button.disabled = false;
      button.textContent = v ? '📺 Casting' : '📺 Cast';
      button.classList.toggle('casting', v);
    }
    if (onStateChange) { try { onStateChange(v); } catch (e) { log('state cb', e); } }
  }

  function currentSession() {
    return castContext ? castContext.getCurrentSession() : null;
  }

  function send(obj) {
    var session = currentSession();
    if (!session) { log('not connected, drop', obj.type); return false; }
    session.sendMessage(NAMESPACE, obj).then(
      function () { /* delivered */ },
      function (err) { log('send failed', err); }
    );
    return true;
  }

  function wireSession(session) {
    if (!session) { setConnected(false); return; }
    setConnected(true);
    session.addMessageListener(NAMESPACE, function (ns, message) {
      log('rx', message);
    });
  }

  function initCast() {
    try {
      castContext = cast.framework.CastContext.getInstance();
    } catch (e) {
      log('Cast SDK not available in this browser');
      if (button) { button.disabled = true; button.textContent = '📺 Cast N/A'; }
      return;
    }
    castContext.setOptions({
      receiverApplicationId: appId,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    castContext.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function (e) {
        var s = e.sessionState;
        var active = (s === cast.framework.SessionState.SESSION_STARTED ||
                      s === cast.framework.SessionState.SESSION_RESUMED);
        wireSession(active ? castContext.getCurrentSession() : null);
      });
    // Pick up an already-running session (e.g. page reloaded mid-session).
    var existing = castContext.getCurrentSession();
    if (existing) wireSession(existing);
    log('ready, appId', appId);
  }

  return {
    NAMESPACE: NAMESPACE,

    init: function (opts) {
      opts = opts || {};
      appId = opts.appId || null;
      button = opts.button || null;
      onStateChange = opts.onStateChange || null;
      if (!appId || appId === 'REPLACE_WITH_APP_ID') {
        log('no App ID configured — see cast/README.md');
        if (button) { button.disabled = true; button.title = 'Set the Cast App ID first'; }
        return;
      }
      if (button) {
        button.addEventListener('click', function () {
          if (!castContext) return;
          var session = currentSession();
          if (session) {
            castContext.endCurrentSession(true);
          } else {
            castContext.requestSession().then(
              function () { /* SESSION_STATE_CHANGED fires */ },
              function (err) { log('requestSession', err); });
          }
        });
      }
      // The Cast SDK calls this when it finishes loading.
      window.__onGCastApiAvailable = function (isAvailable) {
        if (isAvailable) initCast();
        else log('GCast API unavailable');
      };
      // If the SDK already loaded before init ran, boot now.
      if (window.cast && window.cast.framework) {
        initCast();
      }
    },

    isConnected: function () { return connected; },

    session: function (state, label) {
      return send({ type: 'session', state: state, label: label || '' });
    },

    swing: function (s) {
      return send({
        type: 'swing',
        n: s.n,
        exitVeloMph: (typeof s.exitVeloMph === 'number') ? s.exitVeloMph : null,
        launchAngleDeg: (typeof s.launchAngleDeg === 'number') ? s.launchAngleDeg : null,
        at: s.at || ''
      });
    },

    reset: function () {
      return send({ type: 'reset' });
    }
  };
})();
