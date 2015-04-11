var _ = require('underscore');
var Backbone = require('backbone');
var React = require('react');

var Main = require('../app');
var Command = require('../models/commandModel').Command;
var CommandLineStore = require('../stores/CommandLineStore');
var CommandLineActions = require('../actions/CommandLineActions');
var CommandView = require('../react_views/CommandView.jsx');

var Errors = require('../util/errors');
var Warning = Errors.Warning;

var log = require('../log');
var keyboard = require('../util/keyboard');

var CommandPromptView = Backbone.View.extend({
  initialize: function(options) {
    Main.getEvents().on('commandSubmittedPassive', this.addToCommandHistory, this);

    this.index = -1;
    this.commandParagraph = this.$('#prompt p.command')[0];
    this.commandCursor = this.$('#prompt span.cursor')[0];
    this.focus();

    Main.getEvents().on('rollupCommands', this.rollupCommands, this);

    Main.getEventBaton().stealBaton('keydown', this.onKeyDown, this);
    Main.getEventBaton().stealBaton('keyup', this.onKeyUp, this);
  },

  events: {
    'blur #commandTextField': 'hideCursor',
    'focus #commandTextField': 'showCursor'
  },

  blur: function() {
    this.hideCursor();
  },

  focus: function() {
    this.$('#commandTextField').focus();
    this.showCursor();
  },

  hideCursor: function() {
    this.toggleCursor(false);
  },

  showCursor: function() {
    this.toggleCursor(true);
  },

  toggleCursor: function(state) {
    $(this.commandCursor).toggleClass('shown', state);
  },

  onKeyDown: function(e) {
    var el = e.target;
    this.updatePrompt(el);
  },

  onKeyUp: function(e) {
    this.onKeyDown(e);

    // we need to capture some of these events.
    var keyToFuncMap = {
      enter: _.bind(function() {
        this.submit();
      }, this),
      up: _.bind(function() {
        this.commandSelectChange(1);
      }, this),
      down: _.bind(function() {
        this.commandSelectChange(-1);
      }, this)
    };

    var key = keyboard.mapKeycodeToKey(e.which || e.keyCode);
    if (keyToFuncMap[key] !== undefined) {
      e.preventDefault();
      keyToFuncMap[key]();
      this.onKeyDown(e);
    }
  },

  badHtmlEncode: function(text) {
    return text.replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/</g,'&lt;')
      .replace(/ /g,'&nbsp;')
      .replace(/\n/g,'');
  },

  updatePrompt: function(el) {
    el = el || {};  // firefox
    // i WEEEPPPPPPpppppppppppp that this reflow takes so long. it adds this
    // super annoying delay to every keystroke... I have tried everything
    // to make this more performant. getting the srcElement from the event,
    // getting the value directly from the dom, etc etc. yet still,
    // there's a very annoying and sightly noticeable command delay.
    // try.github.com also has this, so I'm assuming those engineers gave up as
    // well...
    var text = $('#commandTextField').val();
    var val = this.badHtmlEncode(text);
    this.commandParagraph.innerHTML = val;

    // now mutate the cursor...
    this.cursorUpdate(text.length, el.selectionStart, el.selectionEnd);
    // and scroll down due to some weird bug
    Main.getEvents().trigger('commandScrollDown');
  },

  cursorUpdate: function(commandLength, selectionStart, selectionEnd) {
    if (selectionStart === undefined || selectionEnd === undefined) {
      selectionStart = Math.max(commandLength - 1, 0);
      selectionEnd = commandLength;
    }

    // 10px for monospaced font at "1" zoom
    var zoom = require('../util/zoomLevel').detectZoom();
    var widthPerChar = 10 * zoom;
    var heightPerRow = 22 * zoom;

    var widthOfParagraph = $(this.commandParagraph).width();
    var numCharsPerLine = widthOfParagraph / widthPerChar;

    var numCharsSelected = Math.min(Math.max(1, selectionEnd - selectionStart), numCharsPerLine);
    var widthOfSelection = String(numCharsSelected * widthPerChar) + 'px';

    // now for positioning
    var leftOffset = String(widthPerChar * (selectionStart % numCharsPerLine)) + 'px';
    var topOffset = String(Math.floor(selectionStart / numCharsPerLine) * heightPerRow) + 'px';

    // one reflow? :D
    $(this.commandCursor).css({
      width: widthOfSelection,
      left: leftOffset,
      top: topOffset
    });
  },

  commandSelectChange: function(delta) {
    this.index += delta;

    // if we are over / under, display blank line. yes this eliminates your
    // partially edited command, but i doubt that is much in this demo
    if (this.index >= CommandLineStore.getCommandHistoryLength() || this.index < 0) {
      this.clear();
      this.index = -1;
      return;
    }

    // yay! we actually can display something
    var commandEntry = CommandLineStore.getCommandHistory()[this.index];
    this.setTextField(commandEntry);
  },

  setTextField: function(value) {
    this.$('#commandTextField').val(value);
  },

  clear: function() {
    this.setTextField('');
  },

  submit: function() {
    var value = this.$('#commandTextField').val().replace('\n', '');
    this.clear();

    this.submitCommand(value);
    this.index = -1;
  },

  rollupCommands: function(numBack) {
    var which = CommandLineStore.getCommandHistory().slice(1, Number(numBack) + 1);
    which.reverse();

    var str = '';
    _.each(which, function(text) {
      str += text + ';';
    }, this);

    CommandLineActions.submitCommand(str);
  },

  addToCommandHistory: function(value) {
    // we should add the command to our local storage history
    // if it's not a blank line and this is a new command...
    // or if we edited the command in place in history
    var shouldAdd = (value.length && this.index === -1) ||
      ((value.length && this.index !== -1 &&
      CommandLineStore.getCommandHistory()[this.index] !== value));

    if (!shouldAdd) {
      return;
    }

    CommandLineActions.submitCommand(value);
    log.commandEntered(value);
  },

  submitCommand: function(value) {
    Main.getEventBaton().trigger('commandSubmitted', value);
  }
});

var CommandLineHistoryView = Backbone.View.extend({
  initialize: function(options) {
    this.collection = options.collection;

    this.collection.on('add', this.addOne, this);
    this.collection.on('reset', this.addAll, this);
    this.collection.on('all', this.render, this);

    this.collection.on('change', this.scrollDown, this);
    Main.getEvents().on('commandScrollDown', this.scrollDown, this);
    Main.getEvents().on('clearOldCommands', this.clearOldCommands, this);
  },

  addWarning: function(msg) {
    var err = new Warning({
      msg: msg
    });

    var command = new Command({
      error: err,
      rawStr: 'Warning:'
    });

    this.collection.add(command);
  },

  clearOldCommands: function() {
    // go through and get rid of every command that is "processed" or done
    var toDestroy = [];

    this.collection.each(function(command) {
      if (command.get('status') !== 'inqueue' &&
          command.get('status') !== 'processing') {
        toDestroy.push(command);
      }
    }, this);

    _.each(toDestroy, function(command) {
      command.destroy();
    }, this);
    this.scrollDown();
  },

  scrollDown: function() {
    // if commandDisplay is ever bigger than #terminal, we need to
    // add overflow-y to terminal and scroll down
    var cD = $('#commandDisplay')[0];
    var t = $('#terminal')[0];

    // firefox hack
    var shouldScroll = (cD.clientHeight > t.clientHeight) ||
      ($(window).height() < cD.clientHeight);
    $(t).toggleClass('scrolling', shouldScroll);
    if (shouldScroll) {
      t.scrollTop = t.scrollHeight;
    }
  },

  addOne: function(command) {
    var div = document.createElement('div');
    div.id = 'command_' + command.cid;
    React.render(
      React.createElement(CommandView, {command: command}),
      div
    );
    this.$('#commandDisplay').append(div);
    this.scrollDown();
  },

  addAll: function() {
    this.collection.each(this.addOne);
  }
});

exports.CommandPromptView = CommandPromptView;
exports.CommandLineHistoryView = CommandLineHistoryView;

