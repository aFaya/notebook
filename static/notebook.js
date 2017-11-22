var Jupyter = Jupyter || {};
var IPython = Jupyter;



// Codemirror
(function(mod) {
    this.CodeMirror = mod();
})(function () {
    "use strict";
  
    // BROWSER SNIFFING
  
    // Kludges for bugs and behavior differences that can't be feature
    // detected are enabled based on userAgent etc sniffing.
  
    var gecko = /gecko\/\d/i.test(navigator.userAgent);
    var ie_upto10 = /MSIE \d/.test(navigator.userAgent);
    var ie_11up = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(navigator.userAgent);
    var ie = ie_upto10 || ie_11up;
    var ie_version = ie && (ie_upto10 ? document.documentMode || 6 : ie_11up[1]);
    var webkit = /WebKit\//.test(navigator.userAgent);
    var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(navigator.userAgent);
    var chrome = /Chrome\//.test(navigator.userAgent);
    var presto = /Opera\//.test(navigator.userAgent);
    var safari = /Apple Computer/.test(navigator.vendor);
    var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(navigator.userAgent);
    var phantom = /PhantomJS/.test(navigator.userAgent);
  
    var ios = /AppleWebKit/.test(navigator.userAgent) && /Mobile\/\w+/.test(navigator.userAgent);
    // This is woefully incomplete. Suggestions for alternative methods welcome.
    var mobile = ios || /Android|webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(navigator.userAgent);
    var mac = ios || /Mac/.test(navigator.platform);
    var windows = /win/i.test(navigator.platform);
  
    var presto_version = presto && navigator.userAgent.match(/Version\/(\d*\.\d*)/);
    if (presto_version) presto_version = Number(presto_version[1]);
    if (presto_version && presto_version >= 15) { presto = false; webkit = true; }
    // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
    var flipCtrlCmd = mac && (qtwebkit || presto && (presto_version == null || presto_version < 12.11));
    var captureRightClick = gecko || (ie && ie_version >= 9);
  
    // Optimize some code when these features are not used.
    var sawReadOnlySpans = false, sawCollapsedSpans = false;
  
    // EDITOR CONSTRUCTOR
  
    // A CodeMirror instance represents an editor. This is the object
    // that user code is usually dealing with.
  
    function CodeMirror(place, options) {
      if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);
  
      this.options = options = options ? copyObj(options) : {};
      // Determine effective options based on given values and defaults.
      copyObj(defaults, options, false);
      setGuttersForLineNumbers(options);
  
      var doc = options.value;
      if (typeof doc == "string") doc = new Doc(doc, options.mode, null, options.lineSeparator);
      this.doc = doc;
  
      var input = new CodeMirror.inputStyles[options.inputStyle](this);
      var display = this.display = new Display(place, doc, input);
      display.wrapper.CodeMirror = this;
      updateGutters(this);
      themeChanged(this);
      if (options.lineWrapping)
        this.display.wrapper.className += " CodeMirror-wrap";
      if (options.autofocus && !mobile) display.input.focus();
      initScrollbars(this);
  
      this.state = {
        keyMaps: [],  // stores maps added by addKeyMap
        overlays: [], // highlighting overlays, as added by addOverlay
        modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
        overwrite: false,
        delayingBlurEvent: false,
        focused: false,
        suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
        pasteIncoming: false, cutIncoming: false, // help recognize paste/cut edits in input.poll
        draggingText: false,
        highlight: new Delayed(), // stores highlight worker timeout
        keySeq: null,  // Unfinished key sequence
        specialChars: null
      };
  
      var cm = this;
  
      // Override magic textarea content restore that IE sometimes does
      // on our hidden textarea on reload
      if (ie && ie_version < 11) setTimeout(function() { cm.display.input.reset(true); }, 20);
  
      registerEventHandlers(this);
      ensureGlobalHandlers();
  
      startOperation(this);
      this.curOp.forceUpdate = true;
      attachDoc(this, doc);
  
      if ((options.autofocus && !mobile) || cm.hasFocus())
        setTimeout(bind(onFocus, this), 20);
      else
        onBlur(this);
  
      for (var opt in optionHandlers) if (optionHandlers.hasOwnProperty(opt))
        optionHandlers[opt](this, options[opt], Init);
      maybeUpdateLineNumberWidth(this);
      if (options.finishInit) options.finishInit(this);
      for (var i = 0; i < initHooks.length; ++i) initHooks[i](this);
      endOperation(this);
      // Suppress optimizelegibility in Webkit, since it breaks text
      // measuring on line wrapping boundaries.
      if (webkit && options.lineWrapping &&
          getComputedStyle(display.lineDiv).textRendering == "optimizelegibility")
        display.lineDiv.style.textRendering = "auto";
    }
  
    // DISPLAY CONSTRUCTOR
  
    // The display handles the DOM integration, both for input reading
    // and content drawing. It holds references to DOM nodes and
    // display-related state.
  
    function Display(place, doc, input) {
      var d = this;
      this.input = input;
  
      // Covers bottom-right square when both scrollbars are present.
      d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
      d.scrollbarFiller.setAttribute("cm-not-content", "true");
      // Covers bottom of gutter when coverGutterNextToScrollbar is on
      // and h scrollbar is present.
      d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
      d.gutterFiller.setAttribute("cm-not-content", "true");
      // Will contain the actual code, positioned to cover the viewport.
      d.lineDiv = elt("div", null, "CodeMirror-code");
      // Elements are added to these to represent selection and cursors.
      d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
      d.cursorDiv = elt("div", null, "CodeMirror-cursors");
      // A visibility: hidden element used to find the size of things.
      d.measure = elt("div", null, "CodeMirror-measure");
      // When lines outside of the viewport are measured, they are drawn in this.
      d.lineMeasure = elt("div", null, "CodeMirror-measure");
      // Wraps everything that needs to exist inside the vertically-padded coordinate system
      d.lineSpace = elt("div", [d.measure, d.lineMeasure, d.selectionDiv, d.cursorDiv, d.lineDiv],
                        null, "position: relative; outline: none");
      // Moved around its parent to cover visible view.
      d.mover = elt("div", [elt("div", [d.lineSpace], "CodeMirror-lines")], null, "position: relative");
      // Set to the height of the document, allowing scrolling.
      d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
      d.sizerWidth = null;
      // Behavior of elts with overflow: auto and padding is
      // inconsistent across browsers. This is used to ensure the
      // scrollable area is big enough.
      d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerGap + "px; width: 1px;");
      // Will contain the gutters, if any.
      d.gutters = elt("div", null, "CodeMirror-gutters");
      d.lineGutter = null;
      // Actual scrollable element.
      d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
      d.scroller.setAttribute("tabIndex", "-1");
      // The element in which the editor lives.
      d.wrapper = elt("div", [d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");
  
      // Work around IE7 z-index bug (not perfect, hence IE7 not really being supported)
      if (ie && ie_version < 8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
      if (!webkit && !(gecko && mobile)) d.scroller.draggable = true;
  
      if (place) {
        if (place.appendChild) place.appendChild(d.wrapper);
        else place(d.wrapper);
      }
  
      // Current rendered range (may be bigger than the view window).
      d.viewFrom = d.viewTo = doc.first;
      d.reportedViewFrom = d.reportedViewTo = doc.first;
      // Information about the rendered lines.
      d.view = [];
      d.renderedView = null;
      // Holds info about a single rendered line when it was rendered
      // for measurement, while not in view.
      d.externalMeasured = null;
      // Empty space (in pixels) above the view
      d.viewOffset = 0;
      d.lastWrapHeight = d.lastWrapWidth = 0;
      d.updateLineNumbers = null;
  
      d.nativeBarWidth = d.barHeight = d.barWidth = 0;
      d.scrollbarsClipped = false;
  
      // Used to only resize the line number gutter when necessary (when
      // the amount of lines crosses a boundary that makes its width change)
      d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
      // Set to true when a non-horizontal-scrolling line widget is
      // added. As an optimization, line widget aligning is skipped when
      // this is false.
      d.alignWidgets = false;
  
      d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
  
      // Tracks the maximum line length so that the horizontal scrollbar
      // can be kept static when scrolling.
      d.maxLine = null;
      d.maxLineLength = 0;
      d.maxLineChanged = false;
  
      // Used for measuring wheel scrolling granularity
      d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;
  
      // True when shift is held down.
      d.shift = false;
  
      // Used to track whether anything happened since the context menu
      // was opened.
      d.selForContextMenu = null;
  
      d.activeTouch = null;
  
      input.init(d);
    }
  
    // STATE UPDATES
  
    // Used to get the editor into a consistent state again when options change.
  
    function loadMode(cm) {
      cm.doc.mode = CodeMirror.getMode(cm.options, cm.doc.modeOption);
      resetModeState(cm);
    }
  
    function resetModeState(cm) {
      cm.doc.iter(function(line) {
        if (line.stateAfter) line.stateAfter = null;
        if (line.styles) line.styles = null;
      });
      cm.doc.frontier = cm.doc.first;
      startWorker(cm, 100);
      cm.state.modeGen++;
      if (cm.curOp) regChange(cm);
    }
  
    function wrappingChanged(cm) {
      if (cm.options.lineWrapping) {
        addClass(cm.display.wrapper, "CodeMirror-wrap");
        cm.display.sizer.style.minWidth = "";
        cm.display.sizerWidth = null;
      } else {
        rmClass(cm.display.wrapper, "CodeMirror-wrap");
        findMaxLine(cm);
      }
      estimateLineHeights(cm);
      regChange(cm);
      clearCaches(cm);
      setTimeout(function(){updateScrollbars(cm);}, 100);
    }
  
    // Returns a function that estimates the height of a line, to use as
    // first approximation until the line becomes visible (and is thus
    // properly measurable).
    function estimateHeight(cm) {
      var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
      var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
      return function(line) {
        if (lineIsHidden(cm.doc, line)) return 0;
  
        var widgetsHeight = 0;
        if (line.widgets) for (var i = 0; i < line.widgets.length; i++) {
          if (line.widgets[i].height) widgetsHeight += line.widgets[i].height;
        }
  
        if (wrapping)
          return widgetsHeight + (Math.ceil(line.text.length / perLine) || 1) * th;
        else
          return widgetsHeight + th;
      };
    }
  
    function estimateLineHeights(cm) {
      var doc = cm.doc, est = estimateHeight(cm);
      doc.iter(function(line) {
        var estHeight = est(line);
        if (estHeight != line.height) updateLineHeight(line, estHeight);
      });
    }
  
    function themeChanged(cm) {
      cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-s-\S+/g, "") +
        cm.options.theme.replace(/(^|\s)\s*/g, " cm-s-");
      clearCaches(cm);
    }
  
    function guttersChanged(cm) {
      updateGutters(cm);
      regChange(cm);
      setTimeout(function(){alignHorizontally(cm);}, 20);
    }
  
    // Rebuild the gutter elements, ensure the margin to the left of the
    // code matches their width.
    function updateGutters(cm) {
      var gutters = cm.display.gutters, specs = cm.options.gutters;
      removeChildren(gutters);
      for (var i = 0; i < specs.length; ++i) {
        var gutterClass = specs[i];
        var gElt = gutters.appendChild(elt("div", null, "CodeMirror-gutter " + gutterClass));
        if (gutterClass == "CodeMirror-linenumbers") {
          cm.display.lineGutter = gElt;
          gElt.style.width = (cm.display.lineNumWidth || 1) + "px";
        }
      }
      gutters.style.display = i ? "" : "none";
      updateGutterSpace(cm);
    }
  
    function updateGutterSpace(cm) {
      var width = cm.display.gutters.offsetWidth;
      cm.display.sizer.style.marginLeft = width + "px";
    }
  
    // Compute the character length of a line, taking into account
    // collapsed ranges (see markText) that might hide parts, and join
    // other lines onto it.
    function lineLength(line) {
      if (line.height == 0) return 0;
      var len = line.text.length, merged, cur = line;
      while (merged = collapsedSpanAtStart(cur)) {
        var found = merged.find(0, true);
        cur = found.from.line;
        len += found.from.ch - found.to.ch;
      }
      cur = line;
      while (merged = collapsedSpanAtEnd(cur)) {
        var found = merged.find(0, true);
        len -= cur.text.length - found.from.ch;
        cur = found.to.line;
        len += cur.text.length - found.to.ch;
      }
      return len;
    }
  
    // Find the longest line in the document.
    function findMaxLine(cm) {
      var d = cm.display, doc = cm.doc;
      d.maxLine = getLine(doc, doc.first);
      d.maxLineLength = lineLength(d.maxLine);
      d.maxLineChanged = true;
      doc.iter(function(line) {
        var len = lineLength(line);
        if (len > d.maxLineLength) {
          d.maxLineLength = len;
          d.maxLine = line;
        }
      });
    }
  
    // Make sure the gutters options contains the element
    // "CodeMirror-linenumbers" when the lineNumbers option is true.
    function setGuttersForLineNumbers(options) {
      var found = indexOf(options.gutters, "CodeMirror-linenumbers");
      if (found == -1 && options.lineNumbers) {
        options.gutters = options.gutters.concat(["CodeMirror-linenumbers"]);
      } else if (found > -1 && !options.lineNumbers) {
        options.gutters = options.gutters.slice(0);
        options.gutters.splice(found, 1);
      }
    }
  
    // SCROLLBARS
  
    // Prepare DOM reads needed to update the scrollbars. Done in one
    // shot to minimize update/measure roundtrips.
    function measureForScrollbars(cm) {
      var d = cm.display, gutterW = d.gutters.offsetWidth;
      var docH = Math.round(cm.doc.height + paddingVert(cm.display));
      return {
        clientHeight: d.scroller.clientHeight,
        viewHeight: d.wrapper.clientHeight,
        scrollWidth: d.scroller.scrollWidth, clientWidth: d.scroller.clientWidth,
        viewWidth: d.wrapper.clientWidth,
        barLeft: cm.options.fixedGutter ? gutterW : 0,
        docHeight: docH,
        scrollHeight: docH + scrollGap(cm) + d.barHeight,
        nativeBarWidth: d.nativeBarWidth,
        gutterWidth: gutterW
      };
    }
  
    function NativeScrollbars(place, scroll, cm) {
      this.cm = cm;
      var vert = this.vert = elt("div", [elt("div", null, null, "min-width: 1px")], "CodeMirror-vscrollbar");
      var horiz = this.horiz = elt("div", [elt("div", null, null, "height: 100%; min-height: 1px")], "CodeMirror-hscrollbar");
      place(vert); place(horiz);
  
      on(vert, "scroll", function() {
        if (vert.clientHeight) scroll(vert.scrollTop, "vertical");
      });
      on(horiz, "scroll", function() {
        if (horiz.clientWidth) scroll(horiz.scrollLeft, "horizontal");
      });
  
      this.checkedOverlay = false;
      // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
      if (ie && ie_version < 8) this.horiz.style.minHeight = this.vert.style.minWidth = "18px";
    }
  
    NativeScrollbars.prototype = copyObj({
      update: function(measure) {
        var needsH = measure.scrollWidth > measure.clientWidth + 1;
        var needsV = measure.scrollHeight > measure.clientHeight + 1;
        var sWidth = measure.nativeBarWidth;
  
        if (needsV) {
          this.vert.style.display = "block";
          this.vert.style.bottom = needsH ? sWidth + "px" : "0";
          var totalHeight = measure.viewHeight - (needsH ? sWidth : 0);
          // A bug in IE8 can cause this value to be negative, so guard it.
          this.vert.firstChild.style.height =
            Math.max(0, measure.scrollHeight - measure.clientHeight + totalHeight) + "px";
        } else {
          this.vert.style.display = "";
          this.vert.firstChild.style.height = "0";
        }
  
        if (needsH) {
          this.horiz.style.display = "block";
          this.horiz.style.right = needsV ? sWidth + "px" : "0";
          this.horiz.style.left = measure.barLeft + "px";
          var totalWidth = measure.viewWidth - measure.barLeft - (needsV ? sWidth : 0);
          this.horiz.firstChild.style.width =
            (measure.scrollWidth - measure.clientWidth + totalWidth) + "px";
        } else {
          this.horiz.style.display = "";
          this.horiz.firstChild.style.width = "0";
        }
  
        if (!this.checkedOverlay && measure.clientHeight > 0) {
          if (sWidth == 0) this.overlayHack();
          this.checkedOverlay = true;
        }
  
        return {right: needsV ? sWidth : 0, bottom: needsH ? sWidth : 0};
      },
      setScrollLeft: function(pos) {
        if (this.horiz.scrollLeft != pos) this.horiz.scrollLeft = pos;
      },
      setScrollTop: function(pos) {
        if (this.vert.scrollTop != pos) this.vert.scrollTop = pos;
      },
      overlayHack: function() {
        var w = mac && !mac_geMountainLion ? "12px" : "18px";
        this.horiz.style.minHeight = this.vert.style.minWidth = w;
        var self = this;
        var barMouseDown = function(e) {
          if (e_target(e) != self.vert && e_target(e) != self.horiz)
            operation(self.cm, onMouseDown)(e);
        };
        on(this.vert, "mousedown", barMouseDown);
        on(this.horiz, "mousedown", barMouseDown);
      },
      clear: function() {
        var parent = this.horiz.parentNode;
        parent.removeChild(this.horiz);
        parent.removeChild(this.vert);
      }
    }, NativeScrollbars.prototype);
  
    function NullScrollbars() {}
  
    NullScrollbars.prototype = copyObj({
      update: function() { return {bottom: 0, right: 0}; },
      setScrollLeft: function() {},
      setScrollTop: function() {},
      clear: function() {}
    }, NullScrollbars.prototype);
  
    CodeMirror.scrollbarModel = {"native": NativeScrollbars, "null": NullScrollbars};
  
    function initScrollbars(cm) {
      if (cm.display.scrollbars) {
        cm.display.scrollbars.clear();
        if (cm.display.scrollbars.addClass)
          rmClass(cm.display.wrapper, cm.display.scrollbars.addClass);
      }
  
      cm.display.scrollbars = new CodeMirror.scrollbarModel[cm.options.scrollbarStyle](function(node) {
        cm.display.wrapper.insertBefore(node, cm.display.scrollbarFiller);
        // Prevent clicks in the scrollbars from killing focus
        on(node, "mousedown", function() {
          if (cm.state.focused) setTimeout(function() { cm.display.input.focus(); }, 0);
        });
        node.setAttribute("cm-not-content", "true");
      }, function(pos, axis) {
        if (axis == "horizontal") setScrollLeft(cm, pos);
        else setScrollTop(cm, pos);
      }, cm);
      if (cm.display.scrollbars.addClass)
        addClass(cm.display.wrapper, cm.display.scrollbars.addClass);
    }
  
    function updateScrollbars(cm, measure) {
      if (!measure) measure = measureForScrollbars(cm);
      var startWidth = cm.display.barWidth, startHeight = cm.display.barHeight;
      updateScrollbarsInner(cm, measure);
      for (var i = 0; i < 4 && startWidth != cm.display.barWidth || startHeight != cm.display.barHeight; i++) {
        if (startWidth != cm.display.barWidth && cm.options.lineWrapping)
          updateHeightsInViewport(cm);
        updateScrollbarsInner(cm, measureForScrollbars(cm));
        startWidth = cm.display.barWidth; startHeight = cm.display.barHeight;
      }
    }
  
    // Re-synchronize the fake scrollbars with the actual size of the
    // content.
    function updateScrollbarsInner(cm, measure) {
      var d = cm.display;
      var sizes = d.scrollbars.update(measure);
  
      d.sizer.style.paddingRight = (d.barWidth = sizes.right) + "px";
      d.sizer.style.paddingBottom = (d.barHeight = sizes.bottom) + "px";
  
      if (sizes.right && sizes.bottom) {
        d.scrollbarFiller.style.display = "block";
        d.scrollbarFiller.style.height = sizes.bottom + "px";
        d.scrollbarFiller.style.width = sizes.right + "px";
      } else d.scrollbarFiller.style.display = "";
      if (sizes.bottom && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
        d.gutterFiller.style.display = "block";
        d.gutterFiller.style.height = sizes.bottom + "px";
        d.gutterFiller.style.width = measure.gutterWidth + "px";
      } else d.gutterFiller.style.display = "";
    }
  
    // Compute the lines that are visible in a given viewport (defaults
    // the the current scroll position). viewport may contain top,
    // height, and ensure (see op.scrollToPos) properties.
    function visibleLines(display, doc, viewport) {
      var top = viewport && viewport.top != null ? Math.max(0, viewport.top) : display.scroller.scrollTop;
      top = Math.floor(top - paddingTop(display));
      var bottom = viewport && viewport.bottom != null ? viewport.bottom : top + display.wrapper.clientHeight;
  
      var from = lineAtHeight(doc, top), to = lineAtHeight(doc, bottom);
      // Ensure is a {from: {line, ch}, to: {line, ch}} object, and
      // forces those lines into the viewport (if possible).
      if (viewport && viewport.ensure) {
        var ensureFrom = viewport.ensure.from.line, ensureTo = viewport.ensure.to.line;
        if (ensureFrom < from) {
          from = ensureFrom;
          to = lineAtHeight(doc, heightAtLine(getLine(doc, ensureFrom)) + display.wrapper.clientHeight);
        } else if (Math.min(ensureTo, doc.lastLine()) >= to) {
          from = lineAtHeight(doc, heightAtLine(getLine(doc, ensureTo)) - display.wrapper.clientHeight);
          to = ensureTo;
        }
      }
      return {from: from, to: Math.max(to, from + 1)};
    }
  
    // LINE NUMBERS
  
    // Re-align line numbers and gutter marks to compensate for
    // horizontal scrolling.
    function alignHorizontally(cm) {
      var display = cm.display, view = display.view;
      if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) return;
      var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
      var gutterW = display.gutters.offsetWidth, left = comp + "px";
      for (var i = 0; i < view.length; i++) if (!view[i].hidden) {
        if (cm.options.fixedGutter && view[i].gutter)
          view[i].gutter.style.left = left;
        var align = view[i].alignable;
        if (align) for (var j = 0; j < align.length; j++)
          align[j].style.left = left;
      }
      if (cm.options.fixedGutter)
        display.gutters.style.left = (comp + gutterW) + "px";
    }
  
    // Used to ensure that the line number gutter is still the right
    // size for the current document size. Returns true when an update
    // is needed.
    function maybeUpdateLineNumberWidth(cm) {
      if (!cm.options.lineNumbers) return false;
      var doc = cm.doc, last = lineNumberFor(cm.options, doc.first + doc.size - 1), display = cm.display;
      if (last.length != display.lineNumChars) {
        var test = display.measure.appendChild(elt("div", [elt("div", last)],
                                                   "CodeMirror-linenumber CodeMirror-gutter-elt"));
        var innerW = test.firstChild.offsetWidth, padding = test.offsetWidth - innerW;
        display.lineGutter.style.width = "";
        display.lineNumInnerWidth = Math.max(innerW, display.lineGutter.offsetWidth - padding) + 1;
        display.lineNumWidth = display.lineNumInnerWidth + padding;
        display.lineNumChars = display.lineNumInnerWidth ? last.length : -1;
        display.lineGutter.style.width = display.lineNumWidth + "px";
        updateGutterSpace(cm);
        return true;
      }
      return false;
    }
  
    function lineNumberFor(options, i) {
      return String(options.lineNumberFormatter(i + options.firstLineNumber));
    }
  
    // Computes display.scroller.scrollLeft + display.gutters.offsetWidth,
    // but using getBoundingClientRect to get a sub-pixel-accurate
    // result.
    function compensateForHScroll(display) {
      return display.scroller.getBoundingClientRect().left - display.sizer.getBoundingClientRect().left;
    }
  
    // DISPLAY DRAWING
  
    function DisplayUpdate(cm, viewport, force) {
      var display = cm.display;
  
      this.viewport = viewport;
      // Store some values that we'll need later (but don't want to force a relayout for)
      this.visible = visibleLines(display, cm.doc, viewport);
      this.editorIsHidden = !display.wrapper.offsetWidth;
      this.wrapperHeight = display.wrapper.clientHeight;
      this.wrapperWidth = display.wrapper.clientWidth;
      this.oldDisplayWidth = displayWidth(cm);
      this.force = force;
      this.dims = getDimensions(cm);
      this.events = [];
    }
  
    DisplayUpdate.prototype.signal = function(emitter, type) {
      if (hasHandler(emitter, type))
        this.events.push(arguments);
    };
    DisplayUpdate.prototype.finish = function() {
      for (var i = 0; i < this.events.length; i++)
        signal.apply(null, this.events[i]);
    };
  
    function maybeClipScrollbars(cm) {
      var display = cm.display;
      if (!display.scrollbarsClipped && display.scroller.offsetWidth) {
        display.nativeBarWidth = display.scroller.offsetWidth - display.scroller.clientWidth;
        display.heightForcer.style.height = scrollGap(cm) + "px";
        display.sizer.style.marginBottom = -display.nativeBarWidth + "px";
        display.sizer.style.borderRightWidth = scrollGap(cm) + "px";
        display.scrollbarsClipped = true;
      }
    }
  
    // Does the actual updating of the line display. Bails out
    // (returning false) when there is nothing to be done and forced is
    // false.
    function updateDisplayIfNeeded(cm, update) {
      var display = cm.display, doc = cm.doc;
  
      if (update.editorIsHidden) {
        resetView(cm);
        return false;
      }
  
      // Bail out if the visible area is already rendered and nothing changed.
      if (!update.force &&
          update.visible.from >= display.viewFrom && update.visible.to <= display.viewTo &&
          (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo) &&
          display.renderedView == display.view && countDirtyView(cm) == 0)
        return false;
  
      if (maybeUpdateLineNumberWidth(cm)) {
        resetView(cm);
        update.dims = getDimensions(cm);
      }
  
      // Compute a suitable new viewport (from & to)
      var end = doc.first + doc.size;
      var from = Math.max(update.visible.from - cm.options.viewportMargin, doc.first);
      var to = Math.min(end, update.visible.to + cm.options.viewportMargin);
      if (display.viewFrom < from && from - display.viewFrom < 20) from = Math.max(doc.first, display.viewFrom);
      if (display.viewTo > to && display.viewTo - to < 20) to = Math.min(end, display.viewTo);
      if (sawCollapsedSpans) {
        from = visualLineNo(cm.doc, from);
        to = visualLineEndNo(cm.doc, to);
      }
  
      var different = from != display.viewFrom || to != display.viewTo ||
        display.lastWrapHeight != update.wrapperHeight || display.lastWrapWidth != update.wrapperWidth;
      adjustView(cm, from, to);
  
      display.viewOffset = heightAtLine(getLine(cm.doc, display.viewFrom));
      // Position the mover div to align with the current scroll position
      cm.display.mover.style.top = display.viewOffset + "px";
  
      var toUpdate = countDirtyView(cm);
      if (!different && toUpdate == 0 && !update.force && display.renderedView == display.view &&
          (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo))
        return false;
  
      // For big changes, we hide the enclosing element during the
      // update, since that speeds up the operations on most browsers.
      var focused = activeElt();
      if (toUpdate > 4) display.lineDiv.style.display = "none";
      patchDisplay(cm, display.updateLineNumbers, update.dims);
      if (toUpdate > 4) display.lineDiv.style.display = "";
      display.renderedView = display.view;
      // There might have been a widget with a focused element that got
      // hidden or updated, if so re-focus it.
      if (focused && activeElt() != focused && focused.offsetHeight) focused.focus();
  
      // Prevent selection and cursors from interfering with the scroll
      // width and height.
      removeChildren(display.cursorDiv);
      removeChildren(display.selectionDiv);
      display.gutters.style.height = display.sizer.style.minHeight = 0;
  
      if (different) {
        display.lastWrapHeight = update.wrapperHeight;
        display.lastWrapWidth = update.wrapperWidth;
        startWorker(cm, 400);
      }
  
      display.updateLineNumbers = null;
  
      return true;
    }
  
    function postUpdateDisplay(cm, update) {
      var viewport = update.viewport;
      for (var first = true;; first = false) {
        if (!first || !cm.options.lineWrapping || update.oldDisplayWidth == displayWidth(cm)) {
          // Clip forced viewport to actual scrollable area.
          if (viewport && viewport.top != null)
            viewport = {top: Math.min(cm.doc.height + paddingVert(cm.display) - displayHeight(cm), viewport.top)};
          // Updated line heights might result in the drawn area not
          // actually covering the viewport. Keep looping until it does.
          update.visible = visibleLines(cm.display, cm.doc, viewport);
          if (update.visible.from >= cm.display.viewFrom && update.visible.to <= cm.display.viewTo)
            break;
        }
        if (!updateDisplayIfNeeded(cm, update)) break;
        updateHeightsInViewport(cm);
        var barMeasure = measureForScrollbars(cm);
        updateSelection(cm);
        setDocumentHeight(cm, barMeasure);
        updateScrollbars(cm, barMeasure);
      }
  
      update.signal(cm, "update", cm);
      if (cm.display.viewFrom != cm.display.reportedViewFrom || cm.display.viewTo != cm.display.reportedViewTo) {
        update.signal(cm, "viewportChange", cm, cm.display.viewFrom, cm.display.viewTo);
        cm.display.reportedViewFrom = cm.display.viewFrom; cm.display.reportedViewTo = cm.display.viewTo;
      }
    }
  
    function updateDisplaySimple(cm, viewport) {
      var update = new DisplayUpdate(cm, viewport);
      if (updateDisplayIfNeeded(cm, update)) {
        updateHeightsInViewport(cm);
        postUpdateDisplay(cm, update);
        var barMeasure = measureForScrollbars(cm);
        updateSelection(cm);
        setDocumentHeight(cm, barMeasure);
        updateScrollbars(cm, barMeasure);
        update.finish();
      }
    }
  
    function setDocumentHeight(cm, measure) {
      cm.display.sizer.style.minHeight = measure.docHeight + "px";
      var total = measure.docHeight + cm.display.barHeight;
      cm.display.heightForcer.style.top = total + "px";
      cm.display.gutters.style.height = Math.max(total + scrollGap(cm), measure.clientHeight) + "px";
    }
  
    // Read the actual heights of the rendered lines, and update their
    // stored heights to match.
    function updateHeightsInViewport(cm) {
      var display = cm.display;
      var prevBottom = display.lineDiv.offsetTop;
      for (var i = 0; i < display.view.length; i++) {
        var cur = display.view[i], height;
        if (cur.hidden) continue;
        if (ie && ie_version < 8) {
          var bot = cur.node.offsetTop + cur.node.offsetHeight;
          height = bot - prevBottom;
          prevBottom = bot;
        } else {
          var box = cur.node.getBoundingClientRect();
          height = box.bottom - box.top;
        }
        var diff = cur.line.height - height;
        if (height < 2) height = textHeight(display);
        if (diff > .001 || diff < -.001) {
          updateLineHeight(cur.line, height);
          updateWidgetHeight(cur.line);
          if (cur.rest) for (var j = 0; j < cur.rest.length; j++)
            updateWidgetHeight(cur.rest[j]);
        }
      }
    }
  
    // Read and store the height of line widgets associated with the
    // given line.
    function updateWidgetHeight(line) {
      if (line.widgets) for (var i = 0; i < line.widgets.length; ++i)
        line.widgets[i].height = line.widgets[i].node.offsetHeight;
    }
  
    // Do a bulk-read of the DOM positions and sizes needed to draw the
    // view, so that we don't interleave reading and writing to the DOM.
    function getDimensions(cm) {
      var d = cm.display, left = {}, width = {};
      var gutterLeft = d.gutters.clientLeft;
      for (var n = d.gutters.firstChild, i = 0; n; n = n.nextSibling, ++i) {
        left[cm.options.gutters[i]] = n.offsetLeft + n.clientLeft + gutterLeft;
        width[cm.options.gutters[i]] = n.clientWidth;
      }
      return {fixedPos: compensateForHScroll(d),
              gutterTotalWidth: d.gutters.offsetWidth,
              gutterLeft: left,
              gutterWidth: width,
              wrapperWidth: d.wrapper.clientWidth};
    }
  
    // Sync the actual display DOM structure with display.view, removing
    // nodes for lines that are no longer in view, and creating the ones
    // that are not there yet, and updating the ones that are out of
    // date.
    function patchDisplay(cm, updateNumbersFrom, dims) {
      var display = cm.display, lineNumbers = cm.options.lineNumbers;
      var container = display.lineDiv, cur = container.firstChild;
  
      function rm(node) {
        var next = node.nextSibling;
        // Works around a throw-scroll bug in OS X Webkit
        if (webkit && mac && cm.display.currentWheelTarget == node)
          node.style.display = "none";
        else
          node.parentNode.removeChild(node);
        return next;
      }
  
      var view = display.view, lineN = display.viewFrom;
      // Loop over the elements in the view, syncing cur (the DOM nodes
      // in display.lineDiv) with the view as we go.
      for (var i = 0; i < view.length; i++) {
        var lineView = view[i];
        if (lineView.hidden) {
        } else if (!lineView.node || lineView.node.parentNode != container) { // Not drawn yet
          var node = buildLineElement(cm, lineView, lineN, dims);
          container.insertBefore(node, cur);
        } else { // Already drawn
          while (cur != lineView.node) cur = rm(cur);
          var updateNumber = lineNumbers && updateNumbersFrom != null &&
            updateNumbersFrom <= lineN && lineView.lineNumber;
          if (lineView.changes) {
            if (indexOf(lineView.changes, "gutter") > -1) updateNumber = false;
            updateLineForChanges(cm, lineView, lineN, dims);
          }
          if (updateNumber) {
            removeChildren(lineView.lineNumber);
            lineView.lineNumber.appendChild(document.createTextNode(lineNumberFor(cm.options, lineN)));
          }
          cur = lineView.node.nextSibling;
        }
        lineN += lineView.size;
      }
      while (cur) cur = rm(cur);
    }
  
    // When an aspect of a line changes, a string is added to
    // lineView.changes. This updates the relevant part of the line's
    // DOM structure.
    function updateLineForChanges(cm, lineView, lineN, dims) {
      for (var j = 0; j < lineView.changes.length; j++) {
        var type = lineView.changes[j];
        if (type == "text") updateLineText(cm, lineView);
        else if (type == "gutter") updateLineGutter(cm, lineView, lineN, dims);
        else if (type == "class") updateLineClasses(lineView);
        else if (type == "widget") updateLineWidgets(cm, lineView, dims);
      }
      lineView.changes = null;
    }
  
    // Lines with gutter elements, widgets or a background class need to
    // be wrapped, and have the extra elements added to the wrapper div
    function ensureLineWrapped(lineView) {
      if (lineView.node == lineView.text) {
        lineView.node = elt("div", null, null, "position: relative");
        if (lineView.text.parentNode)
          lineView.text.parentNode.replaceChild(lineView.node, lineView.text);
        lineView.node.appendChild(lineView.text);
        if (ie && ie_version < 8) lineView.node.style.zIndex = 2;
      }
      return lineView.node;
    }
  
    function updateLineBackground(lineView) {
      var cls = lineView.bgClass ? lineView.bgClass + " " + (lineView.line.bgClass || "") : lineView.line.bgClass;
      if (cls) cls += " CodeMirror-linebackground";
      if (lineView.background) {
        if (cls) lineView.background.className = cls;
        else { lineView.background.parentNode.removeChild(lineView.background); lineView.background = null; }
      } else if (cls) {
        var wrap = ensureLineWrapped(lineView);
        lineView.background = wrap.insertBefore(elt("div", null, cls), wrap.firstChild);
      }
    }
  
    // Wrapper around buildLineContent which will reuse the structure
    // in display.externalMeasured when possible.
    function getLineContent(cm, lineView) {
      var ext = cm.display.externalMeasured;
      if (ext && ext.line == lineView.line) {
        cm.display.externalMeasured = null;
        lineView.measure = ext.measure;
        return ext.built;
      }
      return buildLineContent(cm, lineView);
    }
  
    // Redraw the line's text. Interacts with the background and text
    // classes because the mode may output tokens that influence these
    // classes.
    function updateLineText(cm, lineView) {
      var cls = lineView.text.className;
      var built = getLineContent(cm, lineView);
      if (lineView.text == lineView.node) lineView.node = built.pre;
      lineView.text.parentNode.replaceChild(built.pre, lineView.text);
      lineView.text = built.pre;
      if (built.bgClass != lineView.bgClass || built.textClass != lineView.textClass) {
        lineView.bgClass = built.bgClass;
        lineView.textClass = built.textClass;
        updateLineClasses(lineView);
      } else if (cls) {
        lineView.text.className = cls;
      }
    }
  
    function updateLineClasses(lineView) {
      updateLineBackground(lineView);
      if (lineView.line.wrapClass)
        ensureLineWrapped(lineView).className = lineView.line.wrapClass;
      else if (lineView.node != lineView.text)
        lineView.node.className = "";
      var textClass = lineView.textClass ? lineView.textClass + " " + (lineView.line.textClass || "") : lineView.line.textClass;
      lineView.text.className = textClass || "";
    }
  
    function updateLineGutter(cm, lineView, lineN, dims) {
      if (lineView.gutter) {
        lineView.node.removeChild(lineView.gutter);
        lineView.gutter = null;
      }
      if (lineView.gutterBackground) {
        lineView.node.removeChild(lineView.gutterBackground);
        lineView.gutterBackground = null;
      }
      if (lineView.line.gutterClass) {
        var wrap = ensureLineWrapped(lineView);
        lineView.gutterBackground = elt("div", null, "CodeMirror-gutter-background " + lineView.line.gutterClass,
                                        "left: " + (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) +
                                        "px; width: " + dims.gutterTotalWidth + "px");
        wrap.insertBefore(lineView.gutterBackground, lineView.text);
      }
      var markers = lineView.line.gutterMarkers;
      if (cm.options.lineNumbers || markers) {
        var wrap = ensureLineWrapped(lineView);
        var gutterWrap = lineView.gutter = elt("div", null, "CodeMirror-gutter-wrapper", "left: " +
                                               (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px");
        cm.display.input.setUneditable(gutterWrap);
        wrap.insertBefore(gutterWrap, lineView.text);
        if (lineView.line.gutterClass)
          gutterWrap.className += " " + lineView.line.gutterClass;
        if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
          lineView.lineNumber = gutterWrap.appendChild(
            elt("div", lineNumberFor(cm.options, lineN),
                "CodeMirror-linenumber CodeMirror-gutter-elt",
                "left: " + dims.gutterLeft["CodeMirror-linenumbers"] + "px; width: "
                + cm.display.lineNumInnerWidth + "px"));
        if (markers) for (var k = 0; k < cm.options.gutters.length; ++k) {
          var id = cm.options.gutters[k], found = markers.hasOwnProperty(id) && markers[id];
          if (found)
            gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt", "left: " +
                                       dims.gutterLeft[id] + "px; width: " + dims.gutterWidth[id] + "px"));
        }
      }
    }
  
    function updateLineWidgets(cm, lineView, dims) {
      if (lineView.alignable) lineView.alignable = null;
      for (var node = lineView.node.firstChild, next; node; node = next) {
        var next = node.nextSibling;
        if (node.className == "CodeMirror-linewidget")
          lineView.node.removeChild(node);
      }
      insertLineWidgets(cm, lineView, dims);
    }
  
    // Build a line's DOM representation from scratch
    function buildLineElement(cm, lineView, lineN, dims) {
      var built = getLineContent(cm, lineView);
      lineView.text = lineView.node = built.pre;
      if (built.bgClass) lineView.bgClass = built.bgClass;
      if (built.textClass) lineView.textClass = built.textClass;
  
      updateLineClasses(lineView);
      updateLineGutter(cm, lineView, lineN, dims);
      insertLineWidgets(cm, lineView, dims);
      return lineView.node;
    }
  
    // A lineView may contain multiple logical lines (when merged by
    // collapsed spans). The widgets for all of them need to be drawn.
    function insertLineWidgets(cm, lineView, dims) {
      insertLineWidgetsFor(cm, lineView.line, lineView, dims, true);
      if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
        insertLineWidgetsFor(cm, lineView.rest[i], lineView, dims, false);
    }
  
    function insertLineWidgetsFor(cm, line, lineView, dims, allowAbove) {
      if (!line.widgets) return;
      var wrap = ensureLineWrapped(lineView);
      for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
        var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget");
        if (!widget.handleMouseEvents) node.setAttribute("cm-ignore-events", "true");
        positionLineWidget(widget, node, lineView, dims);
        cm.display.input.setUneditable(node);
        if (allowAbove && widget.above)
          wrap.insertBefore(node, lineView.gutter || lineView.text);
        else
          wrap.appendChild(node);
        signalLater(widget, "redraw");
      }
    }
  
    function positionLineWidget(widget, node, lineView, dims) {
      if (widget.noHScroll) {
        (lineView.alignable || (lineView.alignable = [])).push(node);
        var width = dims.wrapperWidth;
        node.style.left = dims.fixedPos + "px";
        if (!widget.coverGutter) {
          width -= dims.gutterTotalWidth;
          node.style.paddingLeft = dims.gutterTotalWidth + "px";
        }
        node.style.width = width + "px";
      }
      if (widget.coverGutter) {
        node.style.zIndex = 5;
        node.style.position = "relative";
        if (!widget.noHScroll) node.style.marginLeft = -dims.gutterTotalWidth + "px";
      }
    }
  
    // POSITION OBJECT
  
    // A Pos instance represents a position within the text.
    var Pos = CodeMirror.Pos = function(line, ch) {
      if (!(this instanceof Pos)) return new Pos(line, ch);
      this.line = line; this.ch = ch;
    };
  
    // Compare two positions, return 0 if they are the same, a negative
    // number when a is less, and a positive number otherwise.
    var cmp = CodeMirror.cmpPos = function(a, b) { return a.line - b.line || a.ch - b.ch; };
  
    function copyPos(x) {return Pos(x.line, x.ch);}
    function maxPos(a, b) { return cmp(a, b) < 0 ? b : a; }
    function minPos(a, b) { return cmp(a, b) < 0 ? a : b; }
  
    // INPUT HANDLING
  
    function ensureFocus(cm) {
      if (!cm.state.focused) { cm.display.input.focus(); onFocus(cm); }
    }
  
    function isReadOnly(cm) {
      return cm.options.readOnly || cm.doc.cantEdit;
    }
  
    // This will be set to an array of strings when copying, so that,
    // when pasting, we know what kind of selections the copied text
    // was made out of.
    var lastCopied = null;
  
    function applyTextInput(cm, inserted, deleted, sel, origin) {
      var doc = cm.doc;
      cm.display.shift = false;
      if (!sel) sel = doc.sel;
  
      var paste = cm.state.pasteIncoming || origin == "paste";
      var textLines = doc.splitLines(inserted), multiPaste = null;
      // When pasing N lines into N selections, insert one line per selection
      if (paste && sel.ranges.length > 1) {
        if (lastCopied && lastCopied.join("\n") == inserted) {
          if (sel.ranges.length % lastCopied.length == 0) {
            multiPaste = [];
            for (var i = 0; i < lastCopied.length; i++)
              multiPaste.push(doc.splitLines(lastCopied[i]));
          }
        } else if (textLines.length == sel.ranges.length) {
          multiPaste = map(textLines, function(l) { return [l]; });
        }
      }
  
      // Normal behavior is to insert the new text into every selection
      for (var i = sel.ranges.length - 1; i >= 0; i--) {
        var range = sel.ranges[i];
        var from = range.from(), to = range.to();
        if (range.empty()) {
          if (deleted && deleted > 0) // Handle deletion
            from = Pos(from.line, from.ch - deleted);
          else if (cm.state.overwrite && !paste) // Handle overwrite
            to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + lst(textLines).length));
        }
        var updateInput = cm.curOp.updateInput;
        var changeEvent = {from: from, to: to, text: multiPaste ? multiPaste[i % multiPaste.length] : textLines,
                           origin: origin || (paste ? "paste" : cm.state.cutIncoming ? "cut" : "+input")};
        makeChange(cm.doc, changeEvent);
        signalLater(cm, "inputRead", cm, changeEvent);
      }
      if (inserted && !paste)
        triggerElectric(cm, inserted);
  
      ensureCursorVisible(cm);
      cm.curOp.updateInput = updateInput;
      cm.curOp.typing = true;
      cm.state.pasteIncoming = cm.state.cutIncoming = false;
    }
  
    function handlePaste(e, cm) {
      var pasted = e.clipboardData && e.clipboardData.getData("text/plain");
      if (pasted) {
        e.preventDefault();
        runInOp(cm, function() { applyTextInput(cm, pasted, 0, null, "paste"); });
        return true;
      }
    }
  
    function triggerElectric(cm, inserted) {
      // When an 'electric' character is inserted, immediately trigger a reindent
      if (!cm.options.electricChars || !cm.options.smartIndent) return;
      var sel = cm.doc.sel;
  
      for (var i = sel.ranges.length - 1; i >= 0; i--) {
        var range = sel.ranges[i];
        if (range.head.ch > 100 || (i && sel.ranges[i - 1].head.line == range.head.line)) continue;
        var mode = cm.getModeAt(range.head);
        var indented = false;
        if (mode.electricChars) {
          for (var j = 0; j < mode.electricChars.length; j++)
            if (inserted.indexOf(mode.electricChars.charAt(j)) > -1) {
              indented = indentLine(cm, range.head.line, "smart");
              break;
            }
        } else if (mode.electricInput) {
          if (mode.electricInput.test(getLine(cm.doc, range.head.line).text.slice(0, range.head.ch)))
            indented = indentLine(cm, range.head.line, "smart");
        }
        if (indented) signalLater(cm, "electricInput", cm, range.head.line);
      }
    }
  
    function copyableRanges(cm) {
      var text = [], ranges = [];
      for (var i = 0; i < cm.doc.sel.ranges.length; i++) {
        var line = cm.doc.sel.ranges[i].head.line;
        var lineRange = {anchor: Pos(line, 0), head: Pos(line + 1, 0)};
        ranges.push(lineRange);
        text.push(cm.getRange(lineRange.anchor, lineRange.head));
      }
      return {text: text, ranges: ranges};
    }
  
    function disableBrowserMagic(field) {
      field.setAttribute("autocorrect", "off");
      field.setAttribute("autocapitalize", "off");
      field.setAttribute("spellcheck", "false");
    }
  
    // TEXTAREA INPUT STYLE
  
    function TextareaInput(cm) {
      this.cm = cm;
      // See input.poll and input.reset
      this.prevInput = "";
  
      // Flag that indicates whether we expect input to appear real soon
      // now (after some event like 'keypress' or 'input') and are
      // polling intensively.
      this.pollingFast = false;
      // Self-resetting timeout for the poller
      this.polling = new Delayed();
      // Tracks when input.reset has punted to just putting a short
      // string into the textarea instead of the full selection.
      this.inaccurateSelection = false;
      // Used to work around IE issue with selection being forgotten when focus moves away from textarea
      this.hasSelection = false;
      this.composing = null;
    };
  
    function hiddenTextarea() {
      var te = elt("textarea", null, null, "position: absolute; padding: 0; width: 1px; height: 1em; outline: none");
      var div = elt("div", [te], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
      // The textarea is kept positioned near the cursor to prevent the
      // fact that it'll be scrolled into view on input from scrolling
      // our fake cursor out of view. On webkit, when wrap=off, paste is
      // very slow. So make the area wide instead.
      if (webkit) te.style.width = "1000px";
      else te.setAttribute("wrap", "off");
      // If border: 0; -- iOS fails to open keyboard (issue #1287)
      if (ios) te.style.border = "1px solid black";
      disableBrowserMagic(te);
      return div;
    }
  
    TextareaInput.prototype = copyObj({
      init: function(display) {
        var input = this, cm = this.cm;
  
        // Wraps and hides input textarea
        var div = this.wrapper = hiddenTextarea();
        // The semihidden textarea that is focused when the editor is
        // focused, and receives input.
        var te = this.textarea = div.firstChild;
        display.wrapper.insertBefore(div, display.wrapper.firstChild);
  
        // Needed to hide big blue blinking cursor on Mobile Safari (doesn't seem to work in iOS 8 anymore)
        if (ios) te.style.width = "0px";
  
        on(te, "input", function() {
          if (ie && ie_version >= 9 && input.hasSelection) input.hasSelection = null;
          input.poll();
        });
  
        on(te, "paste", function(e) {
          if (handlePaste(e, cm)) return true;
  
          cm.state.pasteIncoming = true;
          input.fastPoll();
        });
  
        function prepareCopyCut(e) {
          if (cm.somethingSelected()) {
            lastCopied = cm.getSelections();
            if (input.inaccurateSelection) {
              input.prevInput = "";
              input.inaccurateSelection = false;
              te.value = lastCopied.join("\n");
              selectInput(te);
            }
          } else if (!cm.options.lineWiseCopyCut) {
            return;
          } else {
            var ranges = copyableRanges(cm);
            lastCopied = ranges.text;
            if (e.type == "cut") {
              cm.setSelections(ranges.ranges, null, sel_dontScroll);
            } else {
              input.prevInput = "";
              te.value = ranges.text.join("\n");
              selectInput(te);
            }
          }
          if (e.type == "cut") cm.state.cutIncoming = true;
        }
        on(te, "cut", prepareCopyCut);
        on(te, "copy", prepareCopyCut);
  
        on(display.scroller, "paste", function(e) {
          if (eventInWidget(display, e)) return;
          cm.state.pasteIncoming = true;
          input.focus();
        });
  
        // Prevent normal selection in the editor (we handle our own)
        on(display.lineSpace, "selectstart", function(e) {
          if (!eventInWidget(display, e)) e_preventDefault(e);
        });
  
        on(te, "compositionstart", function() {
          var start = cm.getCursor("from");
          input.composing = {
            start: start,
            range: cm.markText(start, cm.getCursor("to"), {className: "CodeMirror-composing"})
          };
        });
        on(te, "compositionend", function() {
          if (input.composing) {
            input.poll();
            input.composing.range.clear();
            input.composing = null;
          }
        });
      },
  
      prepareSelection: function() {
        // Redraw the selection and/or cursor
        var cm = this.cm, display = cm.display, doc = cm.doc;
        var result = prepareSelection(cm);
  
        // Move the hidden textarea near the cursor to prevent scrolling artifacts
        if (cm.options.moveInputWithCursor) {
          var headPos = cursorCoords(cm, doc.sel.primary().head, "div");
          var wrapOff = display.wrapper.getBoundingClientRect(), lineOff = display.lineDiv.getBoundingClientRect();
          result.teTop = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                              headPos.top + lineOff.top - wrapOff.top));
          result.teLeft = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                               headPos.left + lineOff.left - wrapOff.left));
        }
  
        return result;
      },
  
      showSelection: function(drawn) {
        var cm = this.cm, display = cm.display;
        removeChildrenAndAdd(display.cursorDiv, drawn.cursors);
        removeChildrenAndAdd(display.selectionDiv, drawn.selection);
        if (drawn.teTop != null) {
          this.wrapper.style.top = drawn.teTop + "px";
          this.wrapper.style.left = drawn.teLeft + "px";
        }
      },
  
      // Reset the input to correspond to the selection (or to be empty,
      // when not typing and nothing is selected)
      reset: function(typing) {
        if (this.contextMenuPending) return;
        var minimal, selected, cm = this.cm, doc = cm.doc;
        if (cm.somethingSelected()) {
          this.prevInput = "";
          var range = doc.sel.primary();
          minimal = hasCopyEvent &&
            (range.to().line - range.from().line > 100 || (selected = cm.getSelection()).length > 1000);
          var content = minimal ? "-" : selected || cm.getSelection();
          this.textarea.value = content;
          if (cm.state.focused) selectInput(this.textarea);
          if (ie && ie_version >= 9) this.hasSelection = content;
        } else if (!typing) {
          this.prevInput = this.textarea.value = "";
          if (ie && ie_version >= 9) this.hasSelection = null;
        }
        this.inaccurateSelection = minimal;
      },
  
      getField: function() { return this.textarea; },
  
      supportsTouch: function() { return false; },
  
      focus: function() {
        if (this.cm.options.readOnly != "nocursor" && (!mobile || activeElt() != this.textarea)) {
          try { this.textarea.focus(); }
          catch (e) {} // IE8 will throw if the textarea is display: none or not in DOM
        }
      },
  
      blur: function() { this.textarea.blur(); },
  
      resetPosition: function() {
        this.wrapper.style.top = this.wrapper.style.left = 0;
      },
  
      receivedFocus: function() { this.slowPoll(); },
  
      // Poll for input changes, using the normal rate of polling. This
      // runs as long as the editor is focused.
      slowPoll: function() {
        var input = this;
        if (input.pollingFast) return;
        input.polling.set(this.cm.options.pollInterval, function() {
          input.poll();
          if (input.cm.state.focused) input.slowPoll();
        });
      },
  
      // When an event has just come in that is likely to add or change
      // something in the input textarea, we poll faster, to ensure that
      // the change appears on the screen quickly.
      fastPoll: function() {
        var missed = false, input = this;
        input.pollingFast = true;
        function p() {
          var changed = input.poll();
          if (!changed && !missed) {missed = true; input.polling.set(60, p);}
          else {input.pollingFast = false; input.slowPoll();}
        }
        input.polling.set(20, p);
      },
  
      // Read input from the textarea, and update the document to match.
      // When something is selected, it is present in the textarea, and
      // selected (unless it is huge, in which case a placeholder is
      // used). When nothing is selected, the cursor sits after previously
      // seen text (can be empty), which is stored in prevInput (we must
      // not reset the textarea when typing, because that breaks IME).
      poll: function() {
        var cm = this.cm, input = this.textarea, prevInput = this.prevInput;
        // Since this is called a *lot*, try to bail out as cheaply as
        // possible when it is clear that nothing happened. hasSelection
        // will be the case when there is a lot of text in the textarea,
        // in which case reading its value would be expensive.
        if (this.contextMenuPending || !cm.state.focused ||
            (hasSelection(input) && !prevInput && !this.composing) ||
            isReadOnly(cm) || cm.options.disableInput || cm.state.keySeq)
          return false;
  
        var text = input.value;
        // If nothing changed, bail.
        if (text == prevInput && !cm.somethingSelected()) return false;
        // Work around nonsensical selection resetting in IE9/10, and
        // inexplicable appearance of private area unicode characters on
        // some key combos in Mac (#2689).
        if (ie && ie_version >= 9 && this.hasSelection === text ||
            mac && /[\uf700-\uf7ff]/.test(text)) {
          cm.display.input.reset();
          return false;
        }
  
        if (cm.doc.sel == cm.display.selForContextMenu) {
          var first = text.charCodeAt(0);
          if (first == 0x200b && !prevInput) prevInput = "\u200b";
          if (first == 0x21da) { this.reset(); return this.cm.execCommand("undo"); }
        }
        // Find the part of the input that is actually new
        var same = 0, l = Math.min(prevInput.length, text.length);
        while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) ++same;
  
        var self = this;
        runInOp(cm, function() {
          applyTextInput(cm, text.slice(same), prevInput.length - same,
                         null, self.composing ? "*compose" : null);
  
          // Don't leave long text in the textarea, since it makes further polling slow
          if (text.length > 1000 || text.indexOf("\n") > -1) input.value = self.prevInput = "";
          else self.prevInput = text;
  
          if (self.composing) {
            self.composing.range.clear();
            self.composing.range = cm.markText(self.composing.start, cm.getCursor("to"),
                                               {className: "CodeMirror-composing"});
          }
        });
        return true;
      },
  
      ensurePolled: function() {
        if (this.pollingFast && this.poll()) this.pollingFast = false;
      },
  
      onKeyPress: function() {
        if (ie && ie_version >= 9) this.hasSelection = null;
        this.fastPoll();
      },
  
      onContextMenu: function(e) {
        var input = this, cm = input.cm, display = cm.display, te = input.textarea;
        var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
        if (!pos || presto) return; // Opera is difficult.
  
        // Reset the current text selection only if the click is done outside of the selection
        // and 'resetSelectionOnContextMenu' option is true.
        var reset = cm.options.resetSelectionOnContextMenu;
        if (reset && cm.doc.sel.contains(pos) == -1)
          operation(cm, setSelection)(cm.doc, simpleSelection(pos), sel_dontScroll);
  
        var oldCSS = te.style.cssText;
        input.wrapper.style.position = "absolute";
        te.style.cssText = "position: fixed; width: 30px; height: 30px; top: " + (e.clientY - 5) +
          "px; left: " + (e.clientX - 5) + "px; z-index: 1000; background: " +
          (ie ? "rgba(255, 255, 255, .05)" : "transparent") +
          "; outline: none; border-width: 0; outline: none; overflow: hidden; opacity: .05; filter: alpha(opacity=5);";
        if (webkit) var oldScrollY = window.scrollY; // Work around Chrome issue (#2712)
        display.input.focus();
        if (webkit) window.scrollTo(null, oldScrollY);
        display.input.reset();
        // Adds "Select all" to context menu in FF
        if (!cm.somethingSelected()) te.value = input.prevInput = " ";
        input.contextMenuPending = true;
        display.selForContextMenu = cm.doc.sel;
        clearTimeout(display.detectingSelectAll);
  
        // Select-all will be greyed out if there's nothing to select, so
        // this adds a zero-width space so that we can later check whether
        // it got selected.
        function prepareSelectAllHack() {
          if (te.selectionStart != null) {
            var selected = cm.somethingSelected();
            var extval = "\u200b" + (selected ? te.value : "");
            te.value = "\u21da"; // Used to catch context-menu undo
            te.value = extval;
            input.prevInput = selected ? "" : "\u200b";
            te.selectionStart = 1; te.selectionEnd = extval.length;
            // Re-set this, in case some other handler touched the
            // selection in the meantime.
            display.selForContextMenu = cm.doc.sel;
          }
        }
        function rehide() {
          input.contextMenuPending = false;
          input.wrapper.style.position = "relative";
          te.style.cssText = oldCSS;
          if (ie && ie_version < 9) display.scrollbars.setScrollTop(display.scroller.scrollTop = scrollPos);
  
          // Try to detect the user choosing select-all
          if (te.selectionStart != null) {
            if (!ie || (ie && ie_version < 9)) prepareSelectAllHack();
            var i = 0, poll = function() {
              if (display.selForContextMenu == cm.doc.sel && te.selectionStart == 0 &&
                  te.selectionEnd > 0 && input.prevInput == "\u200b")
                operation(cm, commands.selectAll)(cm);
              else if (i++ < 10) display.detectingSelectAll = setTimeout(poll, 500);
              else display.input.reset();
            };
            display.detectingSelectAll = setTimeout(poll, 200);
          }
        }
  
        if (ie && ie_version >= 9) prepareSelectAllHack();
        if (captureRightClick) {
          e_stop(e);
          var mouseup = function() {
            off(window, "mouseup", mouseup);
            setTimeout(rehide, 20);
          };
          on(window, "mouseup", mouseup);
        } else {
          setTimeout(rehide, 50);
        }
      },
  
      setUneditable: nothing,
  
      needsContentAttribute: false
    }, TextareaInput.prototype);
  
    // CONTENTEDITABLE INPUT STYLE
  
    function ContentEditableInput(cm) {
      this.cm = cm;
      this.lastAnchorNode = this.lastAnchorOffset = this.lastFocusNode = this.lastFocusOffset = null;
      this.polling = new Delayed();
      this.gracePeriod = false;
    }
  
    ContentEditableInput.prototype = copyObj({
      init: function(display) {
        var input = this, cm = input.cm;
        var div = input.div = display.lineDiv;
        div.contentEditable = "true";
        disableBrowserMagic(div);
  
        on(div, "paste", function(e) { handlePaste(e, cm); })
  
        on(div, "compositionstart", function(e) {
          var data = e.data;
          input.composing = {sel: cm.doc.sel, data: data, startData: data};
          if (!data) return;
          var prim = cm.doc.sel.primary();
          var line = cm.getLine(prim.head.line);
          var found = line.indexOf(data, Math.max(0, prim.head.ch - data.length));
          if (found > -1 && found <= prim.head.ch)
            input.composing.sel = simpleSelection(Pos(prim.head.line, found),
                                                  Pos(prim.head.line, found + data.length));
        });
        on(div, "compositionupdate", function(e) {
          input.composing.data = e.data;
        });
        on(div, "compositionend", function(e) {
          var ours = input.composing;
          if (!ours) return;
          if (e.data != ours.startData && !/\u200b/.test(e.data))
            ours.data = e.data;
          // Need a small delay to prevent other code (input event,
          // selection polling) from doing damage when fired right after
          // compositionend.
          setTimeout(function() {
            if (!ours.handled)
              input.applyComposition(ours);
            if (input.composing == ours)
              input.composing = null;
          }, 50);
        });
  
        on(div, "touchstart", function() {
          input.forceCompositionEnd();
        });
  
        on(div, "input", function() {
          if (input.composing) return;
          if (!input.pollContent())
            runInOp(input.cm, function() {regChange(cm);});
        });
  
        function onCopyCut(e) {
          if (cm.somethingSelected()) {
            lastCopied = cm.getSelections();
            if (e.type == "cut") cm.replaceSelection("", null, "cut");
          } else if (!cm.options.lineWiseCopyCut) {
            return;
          } else {
            var ranges = copyableRanges(cm);
            lastCopied = ranges.text;
            if (e.type == "cut") {
              cm.operation(function() {
                cm.setSelections(ranges.ranges, 0, sel_dontScroll);
                cm.replaceSelection("", null, "cut");
              });
            }
          }
          // iOS exposes the clipboard API, but seems to discard content inserted into it
          if (e.clipboardData && !ios) {
            e.preventDefault();
            e.clipboardData.clearData();
            e.clipboardData.setData("text/plain", lastCopied.join("\n"));
          } else {
            // Old-fashioned briefly-focus-a-textarea hack
            var kludge = hiddenTextarea(), te = kludge.firstChild;
            cm.display.lineSpace.insertBefore(kludge, cm.display.lineSpace.firstChild);
            te.value = lastCopied.join("\n");
            var hadFocus = document.activeElement;
            selectInput(te);
            setTimeout(function() {
              cm.display.lineSpace.removeChild(kludge);
              hadFocus.focus();
            }, 50);
          }
        }
        on(div, "copy", onCopyCut);
        on(div, "cut", onCopyCut);
      },
  
      prepareSelection: function() {
        var result = prepareSelection(this.cm, false);
        result.focus = this.cm.state.focused;
        return result;
      },
  
      showSelection: function(info) {
        if (!info || !this.cm.display.view.length) return;
        if (info.focus) this.showPrimarySelection();
        this.showMultipleSelections(info);
      },
  
      showPrimarySelection: function() {
        var sel = window.getSelection(), prim = this.cm.doc.sel.primary();
        var curAnchor = domToPos(this.cm, sel.anchorNode, sel.anchorOffset);
        var curFocus = domToPos(this.cm, sel.focusNode, sel.focusOffset);
        if (curAnchor && !curAnchor.bad && curFocus && !curFocus.bad &&
            cmp(minPos(curAnchor, curFocus), prim.from()) == 0 &&
            cmp(maxPos(curAnchor, curFocus), prim.to()) == 0)
          return;
  
        var start = posToDOM(this.cm, prim.from());
        var end = posToDOM(this.cm, prim.to());
        if (!start && !end) return;
  
        var view = this.cm.display.view;
        var old = sel.rangeCount && sel.getRangeAt(0);
        if (!start) {
          start = {node: view[0].measure.map[2], offset: 0};
        } else if (!end) { // FIXME dangerously hacky
          var measure = view[view.length - 1].measure;
          var map = measure.maps ? measure.maps[measure.maps.length - 1] : measure.map;
          end = {node: map[map.length - 1], offset: map[map.length - 2] - map[map.length - 3]};
        }
  
        try { var rng = range(start.node, start.offset, end.offset, end.node); }
        catch(e) {} // Our model of the DOM might be outdated, in which case the range we try to set can be impossible
        if (rng) {
          sel.removeAllRanges();
          sel.addRange(rng);
          if (old && sel.anchorNode == null) sel.addRange(old);
          else if (gecko) this.startGracePeriod();
        }
        this.rememberSelection();
      },
  
      startGracePeriod: function() {
        var input = this;
        clearTimeout(this.gracePeriod);
        this.gracePeriod = setTimeout(function() {
          input.gracePeriod = false;
          if (input.selectionChanged())
            input.cm.operation(function() { input.cm.curOp.selectionChanged = true; });
        }, 20);
      },
  
      showMultipleSelections: function(info) {
        removeChildrenAndAdd(this.cm.display.cursorDiv, info.cursors);
        removeChildrenAndAdd(this.cm.display.selectionDiv, info.selection);
      },
  
      rememberSelection: function() {
        var sel = window.getSelection();
        this.lastAnchorNode = sel.anchorNode; this.lastAnchorOffset = sel.anchorOffset;
        this.lastFocusNode = sel.focusNode; this.lastFocusOffset = sel.focusOffset;
      },
  
      selectionInEditor: function() {
        var sel = window.getSelection();
        if (!sel.rangeCount) return false;
        var node = sel.getRangeAt(0).commonAncestorContainer;
        return contains(this.div, node);
      },
  
      focus: function() {
        if (this.cm.options.readOnly != "nocursor") this.div.focus();
      },
      blur: function() { this.div.blur(); },
      getField: function() { return this.div; },
  
      supportsTouch: function() { return true; },
  
      receivedFocus: function() {
        var input = this;
        if (this.selectionInEditor())
          this.pollSelection();
        else
          runInOp(this.cm, function() { input.cm.curOp.selectionChanged = true; });
  
        function poll() {
          if (input.cm.state.focused) {
            input.pollSelection();
            input.polling.set(input.cm.options.pollInterval, poll);
          }
        }
        this.polling.set(this.cm.options.pollInterval, poll);
      },
  
      selectionChanged: function() {
        var sel = window.getSelection();
        return sel.anchorNode != this.lastAnchorNode || sel.anchorOffset != this.lastAnchorOffset ||
          sel.focusNode != this.lastFocusNode || sel.focusOffset != this.lastFocusOffset;
      },
  
      pollSelection: function() {
        if (!this.composing && !this.gracePeriod && this.selectionChanged()) {
          var sel = window.getSelection(), cm = this.cm;
          this.rememberSelection();
          var anchor = domToPos(cm, sel.anchorNode, sel.anchorOffset);
          var head = domToPos(cm, sel.focusNode, sel.focusOffset);
          if (anchor && head) runInOp(cm, function() {
            setSelection(cm.doc, simpleSelection(anchor, head), sel_dontScroll);
            if (anchor.bad || head.bad) cm.curOp.selectionChanged = true;
          });
        }
      },
  
      pollContent: function() {
        var cm = this.cm, display = cm.display, sel = cm.doc.sel.primary();
        var from = sel.from(), to = sel.to();
        if (from.line < display.viewFrom || to.line > display.viewTo - 1) return false;
  
        var fromIndex;
        if (from.line == display.viewFrom || (fromIndex = findViewIndex(cm, from.line)) == 0) {
          var fromLine = lineNo(display.view[0].line);
          var fromNode = display.view[0].node;
        } else {
          var fromLine = lineNo(display.view[fromIndex].line);
          var fromNode = display.view[fromIndex - 1].node.nextSibling;
        }
        var toIndex = findViewIndex(cm, to.line);
        if (toIndex == display.view.length - 1) {
          var toLine = display.viewTo - 1;
          var toNode = display.lineDiv.lastChild;
        } else {
          var toLine = lineNo(display.view[toIndex + 1].line) - 1;
          var toNode = display.view[toIndex + 1].node.previousSibling;
        }
  
        var newText = cm.doc.splitLines(domTextBetween(cm, fromNode, toNode, fromLine, toLine));
        var oldText = getBetween(cm.doc, Pos(fromLine, 0), Pos(toLine, getLine(cm.doc, toLine).text.length));
        while (newText.length > 1 && oldText.length > 1) {
          if (lst(newText) == lst(oldText)) { newText.pop(); oldText.pop(); toLine--; }
          else if (newText[0] == oldText[0]) { newText.shift(); oldText.shift(); fromLine++; }
          else break;
        }
  
        var cutFront = 0, cutEnd = 0;
        var newTop = newText[0], oldTop = oldText[0], maxCutFront = Math.min(newTop.length, oldTop.length);
        while (cutFront < maxCutFront && newTop.charCodeAt(cutFront) == oldTop.charCodeAt(cutFront))
          ++cutFront;
        var newBot = lst(newText), oldBot = lst(oldText);
        var maxCutEnd = Math.min(newBot.length - (newText.length == 1 ? cutFront : 0),
                                 oldBot.length - (oldText.length == 1 ? cutFront : 0));
        while (cutEnd < maxCutEnd &&
               newBot.charCodeAt(newBot.length - cutEnd - 1) == oldBot.charCodeAt(oldBot.length - cutEnd - 1))
          ++cutEnd;
  
        newText[newText.length - 1] = newBot.slice(0, newBot.length - cutEnd);
        newText[0] = newText[0].slice(cutFront);
  
        var chFrom = Pos(fromLine, cutFront);
        var chTo = Pos(toLine, oldText.length ? lst(oldText).length - cutEnd : 0);
        if (newText.length > 1 || newText[0] || cmp(chFrom, chTo)) {
          replaceRange(cm.doc, newText, chFrom, chTo, "+input");
          return true;
        }
      },
  
      ensurePolled: function() {
        this.forceCompositionEnd();
      },
      reset: function() {
        this.forceCompositionEnd();
      },
      forceCompositionEnd: function() {
        if (!this.composing || this.composing.handled) return;
        this.applyComposition(this.composing);
        this.composing.handled = true;
        this.div.blur();
        this.div.focus();
      },
      applyComposition: function(composing) {
        if (composing.data && composing.data != composing.startData)
          operation(this.cm, applyTextInput)(this.cm, composing.data, 0, composing.sel);
      },
  
      setUneditable: function(node) {
        node.setAttribute("contenteditable", "false");
      },
  
      onKeyPress: function(e) {
        e.preventDefault();
        operation(this.cm, applyTextInput)(this.cm, String.fromCharCode(e.charCode == null ? e.keyCode : e.charCode), 0);
      },
  
      onContextMenu: nothing,
      resetPosition: nothing,
  
      needsContentAttribute: true
    }, ContentEditableInput.prototype);
  
    function posToDOM(cm, pos) {
      var view = findViewForLine(cm, pos.line);
      if (!view || view.hidden) return null;
      var line = getLine(cm.doc, pos.line);
      var info = mapFromLineView(view, line, pos.line);
  
      var order = getOrder(line), side = "left";
      if (order) {
        var partPos = getBidiPartAt(order, pos.ch);
        side = partPos % 2 ? "right" : "left";
      }
      var result = nodeAndOffsetInLineMap(info.map, pos.ch, side);
      result.offset = result.collapse == "right" ? result.end : result.start;
      return result;
    }
  
    function badPos(pos, bad) { if (bad) pos.bad = true; return pos; }
  
    function domToPos(cm, node, offset) {
      var lineNode;
      if (node == cm.display.lineDiv) {
        lineNode = cm.display.lineDiv.childNodes[offset];
        if (!lineNode) return badPos(cm.clipPos(Pos(cm.display.viewTo - 1)), true);
        node = null; offset = 0;
      } else {
        for (lineNode = node;; lineNode = lineNode.parentNode) {
          if (!lineNode || lineNode == cm.display.lineDiv) return null;
          if (lineNode.parentNode && lineNode.parentNode == cm.display.lineDiv) break;
        }
      }
      for (var i = 0; i < cm.display.view.length; i++) {
        var lineView = cm.display.view[i];
        if (lineView.node == lineNode)
          return locateNodeInLineView(lineView, node, offset);
      }
    }
  
    function locateNodeInLineView(lineView, node, offset) {
      var wrapper = lineView.text.firstChild, bad = false;
      if (!node || !contains(wrapper, node)) return badPos(Pos(lineNo(lineView.line), 0), true);
      if (node == wrapper) {
        bad = true;
        node = wrapper.childNodes[offset];
        offset = 0;
        if (!node) {
          var line = lineView.rest ? lst(lineView.rest) : lineView.line;
          return badPos(Pos(lineNo(line), line.text.length), bad);
        }
      }
  
      var textNode = node.nodeType == 3 ? node : null, topNode = node;
      if (!textNode && node.childNodes.length == 1 && node.firstChild.nodeType == 3) {
        textNode = node.firstChild;
        if (offset) offset = textNode.nodeValue.length;
      }
      while (topNode.parentNode != wrapper) topNode = topNode.parentNode;
      var measure = lineView.measure, maps = measure.maps;
  
      function find(textNode, topNode, offset) {
        for (var i = -1; i < (maps ? maps.length : 0); i++) {
          var map = i < 0 ? measure.map : maps[i];
          for (var j = 0; j < map.length; j += 3) {
            var curNode = map[j + 2];
            if (curNode == textNode || curNode == topNode) {
              var line = lineNo(i < 0 ? lineView.line : lineView.rest[i]);
              var ch = map[j] + offset;
              if (offset < 0 || curNode != textNode) ch = map[j + (offset ? 1 : 0)];
              return Pos(line, ch);
            }
          }
        }
      }
      var found = find(textNode, topNode, offset);
      if (found) return badPos(found, bad);
  
      // FIXME this is all really shaky. might handle the few cases it needs to handle, but likely to cause problems
      for (var after = topNode.nextSibling, dist = textNode ? textNode.nodeValue.length - offset : 0; after; after = after.nextSibling) {
        found = find(after, after.firstChild, 0);
        if (found)
          return badPos(Pos(found.line, found.ch - dist), bad);
        else
          dist += after.textContent.length;
      }
      for (var before = topNode.previousSibling, dist = offset; before; before = before.previousSibling) {
        found = find(before, before.firstChild, -1);
        if (found)
          return badPos(Pos(found.line, found.ch + dist), bad);
        else
          dist += after.textContent.length;
      }
    }
  
    function domTextBetween(cm, from, to, fromLine, toLine) {
      var text = "", closing = false, lineSep = cm.doc.lineSeparator();
      function recognizeMarker(id) { return function(marker) { return marker.id == id; }; }
      function walk(node) {
        if (node.nodeType == 1) {
          var cmText = node.getAttribute("cm-text");
          if (cmText != null) {
            if (cmText == "") cmText = node.textContent.replace(/\u200b/g, "");
            text += cmText;
            return;
          }
          var markerID = node.getAttribute("cm-marker"), range;
          if (markerID) {
            var found = cm.findMarks(Pos(fromLine, 0), Pos(toLine + 1, 0), recognizeMarker(+markerID));
            if (found.length && (range = found[0].find()))
              text += getBetween(cm.doc, range.from, range.to).join(lineSep);
            return;
          }
          if (node.getAttribute("contenteditable") == "false") return;
          for (var i = 0; i < node.childNodes.length; i++)
            walk(node.childNodes[i]);
          if (/^(pre|div|p)$/i.test(node.nodeName))
            closing = true;
        } else if (node.nodeType == 3) {
          var val = node.nodeValue;
          if (!val) return;
          if (closing) {
            text += lineSep;
            closing = false;
          }
          text += val;
        }
      }
      for (;;) {
        walk(from);
        if (from == to) break;
        from = from.nextSibling;
      }
      return text;
    }
  
    CodeMirror.inputStyles = {"textarea": TextareaInput, "contenteditable": ContentEditableInput};
  
    // SELECTION / CURSOR
  
    // Selection objects are immutable. A new one is created every time
    // the selection changes. A selection is one or more non-overlapping
    // (and non-touching) ranges, sorted, and an integer that indicates
    // which one is the primary selection (the one that's scrolled into
    // view, that getCursor returns, etc).
    function Selection(ranges, primIndex) {
      this.ranges = ranges;
      this.primIndex = primIndex;
    }
  
    Selection.prototype = {
      primary: function() { return this.ranges[this.primIndex]; },
      equals: function(other) {
        if (other == this) return true;
        if (other.primIndex != this.primIndex || other.ranges.length != this.ranges.length) return false;
        for (var i = 0; i < this.ranges.length; i++) {
          var here = this.ranges[i], there = other.ranges[i];
          if (cmp(here.anchor, there.anchor) != 0 || cmp(here.head, there.head) != 0) return false;
        }
        return true;
      },
      deepCopy: function() {
        for (var out = [], i = 0; i < this.ranges.length; i++)
          out[i] = new Range(copyPos(this.ranges[i].anchor), copyPos(this.ranges[i].head));
        return new Selection(out, this.primIndex);
      },
      somethingSelected: function() {
        for (var i = 0; i < this.ranges.length; i++)
          if (!this.ranges[i].empty()) return true;
        return false;
      },
      contains: function(pos, end) {
        if (!end) end = pos;
        for (var i = 0; i < this.ranges.length; i++) {
          var range = this.ranges[i];
          if (cmp(end, range.from()) >= 0 && cmp(pos, range.to()) <= 0)
            return i;
        }
        return -1;
      }
    };
  
    function Range(anchor, head) {
      this.anchor = anchor; this.head = head;
    }
  
    Range.prototype = {
      from: function() { return minPos(this.anchor, this.head); },
      to: function() { return maxPos(this.anchor, this.head); },
      empty: function() {
        return this.head.line == this.anchor.line && this.head.ch == this.anchor.ch;
      }
    };
  
    // Take an unsorted, potentially overlapping set of ranges, and
    // build a selection out of it. 'Consumes' ranges array (modifying
    // it).
    function normalizeSelection(ranges, primIndex) {
      var prim = ranges[primIndex];
      ranges.sort(function(a, b) { return cmp(a.from(), b.from()); });
      primIndex = indexOf(ranges, prim);
      for (var i = 1; i < ranges.length; i++) {
        var cur = ranges[i], prev = ranges[i - 1];
        if (cmp(prev.to(), cur.from()) >= 0) {
          var from = minPos(prev.from(), cur.from()), to = maxPos(prev.to(), cur.to());
          var inv = prev.empty() ? cur.from() == cur.head : prev.from() == prev.head;
          if (i <= primIndex) --primIndex;
          ranges.splice(--i, 2, new Range(inv ? to : from, inv ? from : to));
        }
      }
      return new Selection(ranges, primIndex);
    }
  
    function simpleSelection(anchor, head) {
      return new Selection([new Range(anchor, head || anchor)], 0);
    }
  
    // Most of the external API clips given positions to make sure they
    // actually exist within the document.
    function clipLine(doc, n) {return Math.max(doc.first, Math.min(n, doc.first + doc.size - 1));}
    function clipPos(doc, pos) {
      if (pos.line < doc.first) return Pos(doc.first, 0);
      var last = doc.first + doc.size - 1;
      if (pos.line > last) return Pos(last, getLine(doc, last).text.length);
      return clipToLen(pos, getLine(doc, pos.line).text.length);
    }
    function clipToLen(pos, linelen) {
      var ch = pos.ch;
      if (ch == null || ch > linelen) return Pos(pos.line, linelen);
      else if (ch < 0) return Pos(pos.line, 0);
      else return pos;
    }
    function isLine(doc, l) {return l >= doc.first && l < doc.first + doc.size;}
    function clipPosArray(doc, array) {
      for (var out = [], i = 0; i < array.length; i++) out[i] = clipPos(doc, array[i]);
      return out;
    }
  
    // SELECTION UPDATES
  
    // The 'scroll' parameter given to many of these indicated whether
    // the new cursor position should be scrolled into view after
    // modifying the selection.
  
    // If shift is held or the extend flag is set, extends a range to
    // include a given position (and optionally a second position).
    // Otherwise, simply returns the range between the given positions.
    // Used for cursor motion and such.
    function extendRange(doc, range, head, other) {
      if (doc.cm && doc.cm.display.shift || doc.extend) {
        var anchor = range.anchor;
        if (other) {
          var posBefore = cmp(head, anchor) < 0;
          if (posBefore != (cmp(other, anchor) < 0)) {
            anchor = head;
            head = other;
          } else if (posBefore != (cmp(head, other) < 0)) {
            head = other;
          }
        }
        return new Range(anchor, head);
      } else {
        return new Range(other || head, head);
      }
    }
  
    // Extend the primary selection range, discard the rest.
    function extendSelection(doc, head, other, options) {
      setSelection(doc, new Selection([extendRange(doc, doc.sel.primary(), head, other)], 0), options);
    }
  
    // Extend all selections (pos is an array of selections with length
    // equal the number of selections)
    function extendSelections(doc, heads, options) {
      for (var out = [], i = 0; i < doc.sel.ranges.length; i++)
        out[i] = extendRange(doc, doc.sel.ranges[i], heads[i], null);
      var newSel = normalizeSelection(out, doc.sel.primIndex);
      setSelection(doc, newSel, options);
    }
  
    // Updates a single range in the selection.
    function replaceOneSelection(doc, i, range, options) {
      var ranges = doc.sel.ranges.slice(0);
      ranges[i] = range;
      setSelection(doc, normalizeSelection(ranges, doc.sel.primIndex), options);
    }
  
    // Reset the selection to a single range.
    function setSimpleSelection(doc, anchor, head, options) {
      setSelection(doc, simpleSelection(anchor, head), options);
    }
  
    // Give beforeSelectionChange handlers a change to influence a
    // selection update.
    function filterSelectionChange(doc, sel) {
      var obj = {
        ranges: sel.ranges,
        update: function(ranges) {
          this.ranges = [];
          for (var i = 0; i < ranges.length; i++)
            this.ranges[i] = new Range(clipPos(doc, ranges[i].anchor),
                                       clipPos(doc, ranges[i].head));
        }
      };
      signal(doc, "beforeSelectionChange", doc, obj);
      if (doc.cm) signal(doc.cm, "beforeSelectionChange", doc.cm, obj);
      if (obj.ranges != sel.ranges) return normalizeSelection(obj.ranges, obj.ranges.length - 1);
      else return sel;
    }
  
    function setSelectionReplaceHistory(doc, sel, options) {
      var done = doc.history.done, last = lst(done);
      if (last && last.ranges) {
        done[done.length - 1] = sel;
        setSelectionNoUndo(doc, sel, options);
      } else {
        setSelection(doc, sel, options);
      }
    }
  
    // Set a new selection.
    function setSelection(doc, sel, options) {
      setSelectionNoUndo(doc, sel, options);
      addSelectionToHistory(doc, doc.sel, doc.cm ? doc.cm.curOp.id : NaN, options);
    }
  
    function setSelectionNoUndo(doc, sel, options) {
      if (hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange"))
        sel = filterSelectionChange(doc, sel);
  
      var bias = options && options.bias ||
        (cmp(sel.primary().head, doc.sel.primary().head) < 0 ? -1 : 1);
      setSelectionInner(doc, skipAtomicInSelection(doc, sel, bias, true));
  
      if (!(options && options.scroll === false) && doc.cm)
        ensureCursorVisible(doc.cm);
    }
  
    function setSelectionInner(doc, sel) {
      if (sel.equals(doc.sel)) return;
  
      doc.sel = sel;
  
      if (doc.cm) {
        doc.cm.curOp.updateInput = doc.cm.curOp.selectionChanged = true;
        signalCursorActivity(doc.cm);
      }
      signalLater(doc, "cursorActivity", doc);
    }
  
    // Verify that the selection does not partially select any atomic
    // marked ranges.
    function reCheckSelection(doc) {
      setSelectionInner(doc, skipAtomicInSelection(doc, doc.sel, null, false), sel_dontScroll);
    }
  
    // Return a selection that does not partially select any atomic
    // ranges.
    function skipAtomicInSelection(doc, sel, bias, mayClear) {
      var out;
      for (var i = 0; i < sel.ranges.length; i++) {
        var range = sel.ranges[i];
        var newAnchor = skipAtomic(doc, range.anchor, bias, mayClear);
        var newHead = skipAtomic(doc, range.head, bias, mayClear);
        if (out || newAnchor != range.anchor || newHead != range.head) {
          if (!out) out = sel.ranges.slice(0, i);
          out[i] = new Range(newAnchor, newHead);
        }
      }
      return out ? normalizeSelection(out, sel.primIndex) : sel;
    }
  
    // Ensure a given position is not inside an atomic range.
    function skipAtomic(doc, pos, bias, mayClear) {
      var flipped = false, curPos = pos;
      var dir = bias || 1;
      doc.cantEdit = false;
      search: for (;;) {
        var line = getLine(doc, curPos.line);
        if (line.markedSpans) {
          for (var i = 0; i < line.markedSpans.length; ++i) {
            var sp = line.markedSpans[i], m = sp.marker;
            if ((sp.from == null || (m.inclusiveLeft ? sp.from <= curPos.ch : sp.from < curPos.ch)) &&
                (sp.to == null || (m.inclusiveRight ? sp.to >= curPos.ch : sp.to > curPos.ch))) {
              if (mayClear) {
                signal(m, "beforeCursorEnter");
                if (m.explicitlyCleared) {
                  if (!line.markedSpans) break;
                  else {--i; continue;}
                }
              }
              if (!m.atomic) continue;
              var newPos = m.find(dir < 0 ? -1 : 1);
              if (cmp(newPos, curPos) == 0) {
                newPos.ch += dir;
                if (newPos.ch < 0) {
                  if (newPos.line > doc.first) newPos = clipPos(doc, Pos(newPos.line - 1));
                  else newPos = null;
                } else if (newPos.ch > line.text.length) {
                  if (newPos.line < doc.first + doc.size - 1) newPos = Pos(newPos.line + 1, 0);
                  else newPos = null;
                }
                if (!newPos) {
                  if (flipped) {
                    // Driven in a corner -- no valid cursor position found at all
                    // -- try again *with* clearing, if we didn't already
                    if (!mayClear) return skipAtomic(doc, pos, bias, true);
                    // Otherwise, turn off editing until further notice, and return the start of the doc
                    doc.cantEdit = true;
                    return Pos(doc.first, 0);
                  }
                  flipped = true; newPos = pos; dir = -dir;
                }
              }
              curPos = newPos;
              continue search;
            }
          }
        }
        return curPos;
      }
    }
  
    // SELECTION DRAWING
  
    function updateSelection(cm) {
      cm.display.input.showSelection(cm.display.input.prepareSelection());
    }
  
    function prepareSelection(cm, primary) {
      var doc = cm.doc, result = {};
      var curFragment = result.cursors = document.createDocumentFragment();
      var selFragment = result.selection = document.createDocumentFragment();
  
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        if (primary === false && i == doc.sel.primIndex) continue;
        var range = doc.sel.ranges[i];
        var collapsed = range.empty();
        if (collapsed || cm.options.showCursorWhenSelecting)
          drawSelectionCursor(cm, range, curFragment);
        if (!collapsed)
          drawSelectionRange(cm, range, selFragment);
      }
      return result;
    }
  
    // Draws a cursor for the given range
    function drawSelectionCursor(cm, range, output) {
      var pos = cursorCoords(cm, range.head, "div", null, null, !cm.options.singleCursorHeightPerLine);
  
      var cursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor"));
      cursor.style.left = pos.left + "px";
      cursor.style.top = pos.top + "px";
      cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";
  
      if (pos.other) {
        // Secondary cursor, shown when on a 'jump' in bi-directional text
        var otherCursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor"));
        otherCursor.style.display = "";
        otherCursor.style.left = pos.other.left + "px";
        otherCursor.style.top = pos.other.top + "px";
        otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
      }
    }
  
    // Draws the given range as a highlighted selection
    function drawSelectionRange(cm, range, output) {
      var display = cm.display, doc = cm.doc;
      var fragment = document.createDocumentFragment();
      var padding = paddingH(cm.display), leftSide = padding.left;
      var rightSide = Math.max(display.sizerWidth, displayWidth(cm) - display.sizer.offsetLeft) - padding.right;
  
      function add(left, top, width, bottom) {
        if (top < 0) top = 0;
        top = Math.round(top);
        bottom = Math.round(bottom);
        fragment.appendChild(elt("div", null, "CodeMirror-selected", "position: absolute; left: " + left +
                                 "px; top: " + top + "px; width: " + (width == null ? rightSide - left : width) +
                                 "px; height: " + (bottom - top) + "px"));
      }
  
      function drawForLine(line, fromArg, toArg) {
        var lineObj = getLine(doc, line);
        var lineLen = lineObj.text.length;
        var start, end;
        function coords(ch, bias) {
          return charCoords(cm, Pos(line, ch), "div", lineObj, bias);
        }
  
        iterateBidiSections(getOrder(lineObj), fromArg || 0, toArg == null ? lineLen : toArg, function(from, to, dir) {
          var leftPos = coords(from, "left"), rightPos, left, right;
          if (from == to) {
            rightPos = leftPos;
            left = right = leftPos.left;
          } else {
            rightPos = coords(to - 1, "right");
            if (dir == "rtl") { var tmp = leftPos; leftPos = rightPos; rightPos = tmp; }
            left = leftPos.left;
            right = rightPos.right;
          }
          if (fromArg == null && from == 0) left = leftSide;
          if (rightPos.top - leftPos.top > 3) { // Different lines, draw top part
            add(left, leftPos.top, null, leftPos.bottom);
            left = leftSide;
            if (leftPos.bottom < rightPos.top) add(left, leftPos.bottom, null, rightPos.top);
          }
          if (toArg == null && to == lineLen) right = rightSide;
          if (!start || leftPos.top < start.top || leftPos.top == start.top && leftPos.left < start.left)
            start = leftPos;
          if (!end || rightPos.bottom > end.bottom || rightPos.bottom == end.bottom && rightPos.right > end.right)
            end = rightPos;
          if (left < leftSide + 1) left = leftSide;
          add(left, rightPos.top, right - left, rightPos.bottom);
        });
        return {start: start, end: end};
      }
  
      var sFrom = range.from(), sTo = range.to();
      if (sFrom.line == sTo.line) {
        drawForLine(sFrom.line, sFrom.ch, sTo.ch);
      } else {
        var fromLine = getLine(doc, sFrom.line), toLine = getLine(doc, sTo.line);
        var singleVLine = visualLine(fromLine) == visualLine(toLine);
        var leftEnd = drawForLine(sFrom.line, sFrom.ch, singleVLine ? fromLine.text.length + 1 : null).end;
        var rightStart = drawForLine(sTo.line, singleVLine ? 0 : null, sTo.ch).start;
        if (singleVLine) {
          if (leftEnd.top < rightStart.top - 2) {
            add(leftEnd.right, leftEnd.top, null, leftEnd.bottom);
            add(leftSide, rightStart.top, rightStart.left, rightStart.bottom);
          } else {
            add(leftEnd.right, leftEnd.top, rightStart.left - leftEnd.right, leftEnd.bottom);
          }
        }
        if (leftEnd.bottom < rightStart.top)
          add(leftSide, leftEnd.bottom, null, rightStart.top);
      }
  
      output.appendChild(fragment);
    }
  
    // Cursor-blinking
    function restartBlink(cm) {
      if (!cm.state.focused) return;
      var display = cm.display;
      clearInterval(display.blinker);
      var on = true;
      display.cursorDiv.style.visibility = "";
      if (cm.options.cursorBlinkRate > 0)
        display.blinker = setInterval(function() {
          display.cursorDiv.style.visibility = (on = !on) ? "" : "hidden";
        }, cm.options.cursorBlinkRate);
      else if (cm.options.cursorBlinkRate < 0)
        display.cursorDiv.style.visibility = "hidden";
    }
  
    // HIGHLIGHT WORKER
  
    function startWorker(cm, time) {
      if (cm.doc.mode.startState && cm.doc.frontier < cm.display.viewTo)
        cm.state.highlight.set(time, bind(highlightWorker, cm));
    }
  
    function highlightWorker(cm) {
      var doc = cm.doc;
      if (doc.frontier < doc.first) doc.frontier = doc.first;
      if (doc.frontier >= cm.display.viewTo) return;
      var end = +new Date + cm.options.workTime;
      var state = copyState(doc.mode, getStateBefore(cm, doc.frontier));
      var changedLines = [];
  
      doc.iter(doc.frontier, Math.min(doc.first + doc.size, cm.display.viewTo + 500), function(line) {
        if (doc.frontier >= cm.display.viewFrom) { // Visible
          var oldStyles = line.styles;
          var highlighted = highlightLine(cm, line, state, true);
          line.styles = highlighted.styles;
          var oldCls = line.styleClasses, newCls = highlighted.classes;
          if (newCls) line.styleClasses = newCls;
          else if (oldCls) line.styleClasses = null;
          var ischange = !oldStyles || oldStyles.length != line.styles.length ||
            oldCls != newCls && (!oldCls || !newCls || oldCls.bgClass != newCls.bgClass || oldCls.textClass != newCls.textClass);
          for (var i = 0; !ischange && i < oldStyles.length; ++i) ischange = oldStyles[i] != line.styles[i];
          if (ischange) changedLines.push(doc.frontier);
          line.stateAfter = copyState(doc.mode, state);
        } else {
          processLine(cm, line.text, state);
          line.stateAfter = doc.frontier % 5 == 0 ? copyState(doc.mode, state) : null;
        }
        ++doc.frontier;
        if (+new Date > end) {
          startWorker(cm, cm.options.workDelay);
          return true;
        }
      });
      if (changedLines.length) runInOp(cm, function() {
        for (var i = 0; i < changedLines.length; i++)
          regLineChange(cm, changedLines[i], "text");
      });
    }
  
    // Finds the line to start with when starting a parse. Tries to
    // find a line with a stateAfter, so that it can start with a
    // valid state. If that fails, it returns the line with the
    // smallest indentation, which tends to need the least context to
    // parse correctly.
    function findStartLine(cm, n, precise) {
      var minindent, minline, doc = cm.doc;
      var lim = precise ? -1 : n - (cm.doc.mode.innerMode ? 1000 : 100);
      for (var search = n; search > lim; --search) {
        if (search <= doc.first) return doc.first;
        var line = getLine(doc, search - 1);
        if (line.stateAfter && (!precise || search <= doc.frontier)) return search;
        var indented = countColumn(line.text, null, cm.options.tabSize);
        if (minline == null || minindent > indented) {
          minline = search - 1;
          minindent = indented;
        }
      }
      return minline;
    }
  
    function getStateBefore(cm, n, precise) {
      var doc = cm.doc, display = cm.display;
      if (!doc.mode.startState) return true;
      var pos = findStartLine(cm, n, precise), state = pos > doc.first && getLine(doc, pos-1).stateAfter;
      if (!state) state = startState(doc.mode);
      else state = copyState(doc.mode, state);
      doc.iter(pos, n, function(line) {
        processLine(cm, line.text, state);
        var save = pos == n - 1 || pos % 5 == 0 || pos >= display.viewFrom && pos < display.viewTo;
        line.stateAfter = save ? copyState(doc.mode, state) : null;
        ++pos;
      });
      if (precise) doc.frontier = pos;
      return state;
    }
  
    // POSITION MEASUREMENT
  
    function paddingTop(display) {return display.lineSpace.offsetTop;}
    function paddingVert(display) {return display.mover.offsetHeight - display.lineSpace.offsetHeight;}
    function paddingH(display) {
      if (display.cachedPaddingH) return display.cachedPaddingH;
      var e = removeChildrenAndAdd(display.measure, elt("pre", "x"));
      var style = window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle;
      var data = {left: parseInt(style.paddingLeft), right: parseInt(style.paddingRight)};
      if (!isNaN(data.left) && !isNaN(data.right)) display.cachedPaddingH = data;
      return data;
    }
  
    function scrollGap(cm) { return scrollerGap - cm.display.nativeBarWidth; }
    function displayWidth(cm) {
      return cm.display.scroller.clientWidth - scrollGap(cm) - cm.display.barWidth;
    }
    function displayHeight(cm) {
      return cm.display.scroller.clientHeight - scrollGap(cm) - cm.display.barHeight;
    }
  
    // Ensure the lineView.wrapping.heights array is populated. This is
    // an array of bottom offsets for the lines that make up a drawn
    // line. When lineWrapping is on, there might be more than one
    // height.
    function ensureLineHeights(cm, lineView, rect) {
      var wrapping = cm.options.lineWrapping;
      var curWidth = wrapping && displayWidth(cm);
      if (!lineView.measure.heights || wrapping && lineView.measure.width != curWidth) {
        var heights = lineView.measure.heights = [];
        if (wrapping) {
          lineView.measure.width = curWidth;
          var rects = lineView.text.firstChild.getClientRects();
          for (var i = 0; i < rects.length - 1; i++) {
            var cur = rects[i], next = rects[i + 1];
            if (Math.abs(cur.bottom - next.bottom) > 2)
              heights.push((cur.bottom + next.top) / 2 - rect.top);
          }
        }
        heights.push(rect.bottom - rect.top);
      }
    }
  
    // Find a line map (mapping character offsets to text nodes) and a
    // measurement cache for the given line number. (A line view might
    // contain multiple lines when collapsed ranges are present.)
    function mapFromLineView(lineView, line, lineN) {
      if (lineView.line == line)
        return {map: lineView.measure.map, cache: lineView.measure.cache};
      for (var i = 0; i < lineView.rest.length; i++)
        if (lineView.rest[i] == line)
          return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i]};
      for (var i = 0; i < lineView.rest.length; i++)
        if (lineNo(lineView.rest[i]) > lineN)
          return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i], before: true};
    }
  
    // Render a line into the hidden node display.externalMeasured. Used
    // when measurement is needed for a line that's not in the viewport.
    function updateExternalMeasurement(cm, line) {
      line = visualLine(line);
      var lineN = lineNo(line);
      var view = cm.display.externalMeasured = new LineView(cm.doc, line, lineN);
      view.lineN = lineN;
      var built = view.built = buildLineContent(cm, view);
      view.text = built.pre;
      removeChildrenAndAdd(cm.display.lineMeasure, built.pre);
      return view;
    }
  
    // Get a {top, bottom, left, right} box (in line-local coordinates)
    // for a given character.
    function measureChar(cm, line, ch, bias) {
      return measureCharPrepared(cm, prepareMeasureForLine(cm, line), ch, bias);
    }
  
    // Find a line view that corresponds to the given line number.
    function findViewForLine(cm, lineN) {
      if (lineN >= cm.display.viewFrom && lineN < cm.display.viewTo)
        return cm.display.view[findViewIndex(cm, lineN)];
      var ext = cm.display.externalMeasured;
      if (ext && lineN >= ext.lineN && lineN < ext.lineN + ext.size)
        return ext;
    }
  
    // Measurement can be split in two steps, the set-up work that
    // applies to the whole line, and the measurement of the actual
    // character. Functions like coordsChar, that need to do a lot of
    // measurements in a row, can thus ensure that the set-up work is
    // only done once.
    function prepareMeasureForLine(cm, line) {
      var lineN = lineNo(line);
      var view = findViewForLine(cm, lineN);
      if (view && !view.text) {
        view = null;
      } else if (view && view.changes) {
        updateLineForChanges(cm, view, lineN, getDimensions(cm));
        cm.curOp.forceUpdate = true;
      }
      if (!view)
        view = updateExternalMeasurement(cm, line);
  
      var info = mapFromLineView(view, line, lineN);
      return {
        line: line, view: view, rect: null,
        map: info.map, cache: info.cache, before: info.before,
        hasHeights: false
      };
    }
  
    // Given a prepared measurement object, measures the position of an
    // actual character (or fetches it from the cache).
    function measureCharPrepared(cm, prepared, ch, bias, varHeight) {
      if (prepared.before) ch = -1;
      var key = ch + (bias || ""), found;
      if (prepared.cache.hasOwnProperty(key)) {
        found = prepared.cache[key];
      } else {
        if (!prepared.rect)
          prepared.rect = prepared.view.text.getBoundingClientRect();
        if (!prepared.hasHeights) {
          ensureLineHeights(cm, prepared.view, prepared.rect);
          prepared.hasHeights = true;
        }
        found = measureCharInner(cm, prepared, ch, bias);
        if (!found.bogus) prepared.cache[key] = found;
      }
      return {left: found.left, right: found.right,
              top: varHeight ? found.rtop : found.top,
              bottom: varHeight ? found.rbottom : found.bottom};
    }
  
    var nullRect = {left: 0, right: 0, top: 0, bottom: 0};
  
    function nodeAndOffsetInLineMap(map, ch, bias) {
      var node, start, end, collapse;
      // First, search the line map for the text node corresponding to,
      // or closest to, the target character.
      for (var i = 0; i < map.length; i += 3) {
        var mStart = map[i], mEnd = map[i + 1];
        if (ch < mStart) {
          start = 0; end = 1;
          collapse = "left";
        } else if (ch < mEnd) {
          start = ch - mStart;
          end = start + 1;
        } else if (i == map.length - 3 || ch == mEnd && map[i + 3] > ch) {
          end = mEnd - mStart;
          start = end - 1;
          if (ch >= mEnd) collapse = "right";
        }
        if (start != null) {
          node = map[i + 2];
          if (mStart == mEnd && bias == (node.insertLeft ? "left" : "right"))
            collapse = bias;
          if (bias == "left" && start == 0)
            while (i && map[i - 2] == map[i - 3] && map[i - 1].insertLeft) {
              node = map[(i -= 3) + 2];
              collapse = "left";
            }
          if (bias == "right" && start == mEnd - mStart)
            while (i < map.length - 3 && map[i + 3] == map[i + 4] && !map[i + 5].insertLeft) {
              node = map[(i += 3) + 2];
              collapse = "right";
            }
          break;
        }
      }
      return {node: node, start: start, end: end, collapse: collapse, coverStart: mStart, coverEnd: mEnd};
    }
  
    function measureCharInner(cm, prepared, ch, bias) {
      var place = nodeAndOffsetInLineMap(prepared.map, ch, bias);
      var node = place.node, start = place.start, end = place.end, collapse = place.collapse;
  
      var rect;
      if (node.nodeType == 3) { // If it is a text node, use a range to retrieve the coordinates.
        for (var i = 0; i < 4; i++) { // Retry a maximum of 4 times when nonsense rectangles are returned
          while (start && isExtendingChar(prepared.line.text.charAt(place.coverStart + start))) --start;
          while (place.coverStart + end < place.coverEnd && isExtendingChar(prepared.line.text.charAt(place.coverStart + end))) ++end;
          if (ie && ie_version < 9 && start == 0 && end == place.coverEnd - place.coverStart) {
            rect = node.parentNode.getBoundingClientRect();
          } else if (ie && cm.options.lineWrapping) {
            var rects = range(node, start, end).getClientRects();
            if (rects.length)
              rect = rects[bias == "right" ? rects.length - 1 : 0];
            else
              rect = nullRect;
          } else {
            rect = range(node, start, end).getBoundingClientRect() || nullRect;
          }
          if (rect.left || rect.right || start == 0) break;
          end = start;
          start = start - 1;
          collapse = "right";
        }
        if (ie && ie_version < 11) rect = maybeUpdateRectForZooming(cm.display.measure, rect);
      } else { // If it is a widget, simply get the box for the whole widget.
        if (start > 0) collapse = bias = "right";
        var rects;
        if (cm.options.lineWrapping && (rects = node.getClientRects()).length > 1)
          rect = rects[bias == "right" ? rects.length - 1 : 0];
        else
          rect = node.getBoundingClientRect();
      }
      if (ie && ie_version < 9 && !start && (!rect || !rect.left && !rect.right)) {
        var rSpan = node.parentNode.getClientRects()[0];
        if (rSpan)
          rect = {left: rSpan.left, right: rSpan.left + charWidth(cm.display), top: rSpan.top, bottom: rSpan.bottom};
        else
          rect = nullRect;
      }
  
      var rtop = rect.top - prepared.rect.top, rbot = rect.bottom - prepared.rect.top;
      var mid = (rtop + rbot) / 2;
      var heights = prepared.view.measure.heights;
      for (var i = 0; i < heights.length - 1; i++)
        if (mid < heights[i]) break;
      var top = i ? heights[i - 1] : 0, bot = heights[i];
      var result = {left: (collapse == "right" ? rect.right : rect.left) - prepared.rect.left,
                    right: (collapse == "left" ? rect.left : rect.right) - prepared.rect.left,
                    top: top, bottom: bot};
      if (!rect.left && !rect.right) result.bogus = true;
      if (!cm.options.singleCursorHeightPerLine) { result.rtop = rtop; result.rbottom = rbot; }
  
      return result;
    }
  
    // Work around problem with bounding client rects on ranges being
    // returned incorrectly when zoomed on IE10 and below.
    function maybeUpdateRectForZooming(measure, rect) {
      if (!window.screen || screen.logicalXDPI == null ||
          screen.logicalXDPI == screen.deviceXDPI || !hasBadZoomedRects(measure))
        return rect;
      var scaleX = screen.logicalXDPI / screen.deviceXDPI;
      var scaleY = screen.logicalYDPI / screen.deviceYDPI;
      return {left: rect.left * scaleX, right: rect.right * scaleX,
              top: rect.top * scaleY, bottom: rect.bottom * scaleY};
    }
  
    function clearLineMeasurementCacheFor(lineView) {
      if (lineView.measure) {
        lineView.measure.cache = {};
        lineView.measure.heights = null;
        if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
          lineView.measure.caches[i] = {};
      }
    }
  
    function clearLineMeasurementCache(cm) {
      cm.display.externalMeasure = null;
      removeChildren(cm.display.lineMeasure);
      for (var i = 0; i < cm.display.view.length; i++)
        clearLineMeasurementCacheFor(cm.display.view[i]);
    }
  
    function clearCaches(cm) {
      clearLineMeasurementCache(cm);
      cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
      if (!cm.options.lineWrapping) cm.display.maxLineChanged = true;
      cm.display.lineNumChars = null;
    }
  
    function pageScrollX() { return window.pageXOffset || (document.documentElement || document.body).scrollLeft; }
    function pageScrollY() { return window.pageYOffset || (document.documentElement || document.body).scrollTop; }
  
    // Converts a {top, bottom, left, right} box from line-local
    // coordinates into another coordinate system. Context may be one of
    // "line", "div" (display.lineDiv), "local"/null (editor), "window",
    // or "page".
    function intoCoordSystem(cm, lineObj, rect, context) {
      if (lineObj.widgets) for (var i = 0; i < lineObj.widgets.length; ++i) if (lineObj.widgets[i].above) {
        var size = widgetHeight(lineObj.widgets[i]);
        rect.top += size; rect.bottom += size;
      }
      if (context == "line") return rect;
      if (!context) context = "local";
      var yOff = heightAtLine(lineObj);
      if (context == "local") yOff += paddingTop(cm.display);
      else yOff -= cm.display.viewOffset;
      if (context == "page" || context == "window") {
        var lOff = cm.display.lineSpace.getBoundingClientRect();
        yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
        var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
        rect.left += xOff; rect.right += xOff;
      }
      rect.top += yOff; rect.bottom += yOff;
      return rect;
    }
  
    // Coverts a box from "div" coords to another coordinate system.
    // Context may be "window", "page", "div", or "local"/null.
    function fromCoordSystem(cm, coords, context) {
      if (context == "div") return coords;
      var left = coords.left, top = coords.top;
      // First move into "page" coordinate system
      if (context == "page") {
        left -= pageScrollX();
        top -= pageScrollY();
      } else if (context == "local" || !context) {
        var localBox = cm.display.sizer.getBoundingClientRect();
        left += localBox.left;
        top += localBox.top;
      }
  
      var lineSpaceBox = cm.display.lineSpace.getBoundingClientRect();
      return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top};
    }
  
    function charCoords(cm, pos, context, lineObj, bias) {
      if (!lineObj) lineObj = getLine(cm.doc, pos.line);
      return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, bias), context);
    }
  
    // Returns a box for a given cursor position, which may have an
    // 'other' property containing the position of the secondary cursor
    // on a bidi boundary.
    function cursorCoords(cm, pos, context, lineObj, preparedMeasure, varHeight) {
      lineObj = lineObj || getLine(cm.doc, pos.line);
      if (!preparedMeasure) preparedMeasure = prepareMeasureForLine(cm, lineObj);
      function get(ch, right) {
        var m = measureCharPrepared(cm, preparedMeasure, ch, right ? "right" : "left", varHeight);
        if (right) m.left = m.right; else m.right = m.left;
        return intoCoordSystem(cm, lineObj, m, context);
      }
      function getBidi(ch, partPos) {
        var part = order[partPos], right = part.level % 2;
        if (ch == bidiLeft(part) && partPos && part.level < order[partPos - 1].level) {
          part = order[--partPos];
          ch = bidiRight(part) - (part.level % 2 ? 0 : 1);
          right = true;
        } else if (ch == bidiRight(part) && partPos < order.length - 1 && part.level < order[partPos + 1].level) {
          part = order[++partPos];
          ch = bidiLeft(part) - part.level % 2;
          right = false;
        }
        if (right && ch == part.to && ch > part.from) return get(ch - 1);
        return get(ch, right);
      }
      var order = getOrder(lineObj), ch = pos.ch;
      if (!order) return get(ch);
      var partPos = getBidiPartAt(order, ch);
      var val = getBidi(ch, partPos);
      if (bidiOther != null) val.other = getBidi(ch, bidiOther);
      return val;
    }
  
    // Used to cheaply estimate the coordinates for a position. Used for
    // intermediate scroll updates.
    function estimateCoords(cm, pos) {
      var left = 0, pos = clipPos(cm.doc, pos);
      if (!cm.options.lineWrapping) left = charWidth(cm.display) * pos.ch;
      var lineObj = getLine(cm.doc, pos.line);
      var top = heightAtLine(lineObj) + paddingTop(cm.display);
      return {left: left, right: left, top: top, bottom: top + lineObj.height};
    }
  
    // Positions returned by coordsChar contain some extra information.
    // xRel is the relative x position of the input coordinates compared
    // to the found position (so xRel > 0 means the coordinates are to
    // the right of the character position, for example). When outside
    // is true, that means the coordinates lie outside the line's
    // vertical range.
    function PosWithInfo(line, ch, outside, xRel) {
      var pos = Pos(line, ch);
      pos.xRel = xRel;
      if (outside) pos.outside = true;
      return pos;
    }
  
    // Compute the character position closest to the given coordinates.
    // Input must be lineSpace-local ("div" coordinate system).
    function coordsChar(cm, x, y) {
      var doc = cm.doc;
      y += cm.display.viewOffset;
      if (y < 0) return PosWithInfo(doc.first, 0, true, -1);
      var lineN = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
      if (lineN > last)
        return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, true, 1);
      if (x < 0) x = 0;
  
      var lineObj = getLine(doc, lineN);
      for (;;) {
        var found = coordsCharInner(cm, lineObj, lineN, x, y);
        var merged = collapsedSpanAtEnd(lineObj);
        var mergedPos = merged && merged.find(0, true);
        if (merged && (found.ch > mergedPos.from.ch || found.ch == mergedPos.from.ch && found.xRel > 0))
          lineN = lineNo(lineObj = mergedPos.to.line);
        else
          return found;
      }
    }
  
    function coordsCharInner(cm, lineObj, lineNo, x, y) {
      var innerOff = y - heightAtLine(lineObj);
      var wrongLine = false, adjust = 2 * cm.display.wrapper.clientWidth;
      var preparedMeasure = prepareMeasureForLine(cm, lineObj);
  
      function getX(ch) {
        var sp = cursorCoords(cm, Pos(lineNo, ch), "line", lineObj, preparedMeasure);
        wrongLine = true;
        if (innerOff > sp.bottom) return sp.left - adjust;
        else if (innerOff < sp.top) return sp.left + adjust;
        else wrongLine = false;
        return sp.left;
      }
  
      var bidi = getOrder(lineObj), dist = lineObj.text.length;
      var from = lineLeft(lineObj), to = lineRight(lineObj);
      var fromX = getX(from), fromOutside = wrongLine, toX = getX(to), toOutside = wrongLine;
  
      if (x > toX) return PosWithInfo(lineNo, to, toOutside, 1);
      // Do a binary search between these bounds.
      for (;;) {
        if (bidi ? to == from || to == moveVisually(lineObj, from, 1) : to - from <= 1) {
          var ch = x < fromX || x - fromX <= toX - x ? from : to;
          var xDiff = x - (ch == from ? fromX : toX);
          while (isExtendingChar(lineObj.text.charAt(ch))) ++ch;
          var pos = PosWithInfo(lineNo, ch, ch == from ? fromOutside : toOutside,
                                xDiff < -1 ? -1 : xDiff > 1 ? 1 : 0);
          return pos;
        }
        var step = Math.ceil(dist / 2), middle = from + step;
        if (bidi) {
          middle = from;
          for (var i = 0; i < step; ++i) middle = moveVisually(lineObj, middle, 1);
        }
        var middleX = getX(middle);
        if (middleX > x) {to = middle; toX = middleX; if (toOutside = wrongLine) toX += 1000; dist = step;}
        else {from = middle; fromX = middleX; fromOutside = wrongLine; dist -= step;}
      }
    }
  
    var measureText;
    // Compute the default text height.
    function textHeight(display) {
      if (display.cachedTextHeight != null) return display.cachedTextHeight;
      if (measureText == null) {
        measureText = elt("pre");
        // Measure a bunch of lines, for browsers that compute
        // fractional heights.
        for (var i = 0; i < 49; ++i) {
          measureText.appendChild(document.createTextNode("x"));
          measureText.appendChild(elt("br"));
        }
        measureText.appendChild(document.createTextNode("x"));
      }
      removeChildrenAndAdd(display.measure, measureText);
      var height = measureText.offsetHeight / 50;
      if (height > 3) display.cachedTextHeight = height;
      removeChildren(display.measure);
      return height || 1;
    }
  
    // Compute the default character width.
    function charWidth(display) {
      if (display.cachedCharWidth != null) return display.cachedCharWidth;
      var anchor = elt("span", "xxxxxxxxxx");
      var pre = elt("pre", [anchor]);
      removeChildrenAndAdd(display.measure, pre);
      var rect = anchor.getBoundingClientRect(), width = (rect.right - rect.left) / 10;
      if (width > 2) display.cachedCharWidth = width;
      return width || 10;
    }
  
    // OPERATIONS
  
    // Operations are used to wrap a series of changes to the editor
    // state in such a way that each change won't have to update the
    // cursor and display (which would be awkward, slow, and
    // error-prone). Instead, display updates are batched and then all
    // combined and executed at once.
  
    var operationGroup = null;
  
    var nextOpId = 0;
    // Start a new operation.
    function startOperation(cm) {
      cm.curOp = {
        cm: cm,
        viewChanged: false,      // Flag that indicates that lines might need to be redrawn
        startHeight: cm.doc.height, // Used to detect need to update scrollbar
        forceUpdate: false,      // Used to force a redraw
        updateInput: null,       // Whether to reset the input textarea
        typing: false,           // Whether this reset should be careful to leave existing text (for compositing)
        changeObjs: null,        // Accumulated changes, for firing change events
        cursorActivityHandlers: null, // Set of handlers to fire cursorActivity on
        cursorActivityCalled: 0, // Tracks which cursorActivity handlers have been called already
        selectionChanged: false, // Whether the selection needs to be redrawn
        updateMaxLine: false,    // Set when the widest line needs to be determined anew
        scrollLeft: null, scrollTop: null, // Intermediate scroll position, not pushed to DOM yet
        scrollToPos: null,       // Used to scroll to a specific position
        focus: false,
        id: ++nextOpId           // Unique ID
      };
      if (operationGroup) {
        operationGroup.ops.push(cm.curOp);
      } else {
        cm.curOp.ownsGroup = operationGroup = {
          ops: [cm.curOp],
          delayedCallbacks: []
        };
      }
    }
  
    function fireCallbacksForOps(group) {
      // Calls delayed callbacks and cursorActivity handlers until no
      // new ones appear
      var callbacks = group.delayedCallbacks, i = 0;
      do {
        for (; i < callbacks.length; i++)
          callbacks[i]();
        for (var j = 0; j < group.ops.length; j++) {
          var op = group.ops[j];
          if (op.cursorActivityHandlers)
            while (op.cursorActivityCalled < op.cursorActivityHandlers.length)
              op.cursorActivityHandlers[op.cursorActivityCalled++](op.cm);
        }
      } while (i < callbacks.length);
    }
  
    // Finish an operation, updating the display and signalling delayed events
    function endOperation(cm) {
      var op = cm.curOp, group = op.ownsGroup;
      if (!group) return;
  
      try { fireCallbacksForOps(group); }
      finally {
        operationGroup = null;
        for (var i = 0; i < group.ops.length; i++)
          group.ops[i].cm.curOp = null;
        endOperations(group);
      }
    }
  
    // The DOM updates done when an operation finishes are batched so
    // that the minimum number of relayouts are required.
    function endOperations(group) {
      var ops = group.ops;
      for (var i = 0; i < ops.length; i++) // Read DOM
        endOperation_R1(ops[i]);
      for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
        endOperation_W1(ops[i]);
      for (var i = 0; i < ops.length; i++) // Read DOM
        endOperation_R2(ops[i]);
      for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
        endOperation_W2(ops[i]);
      for (var i = 0; i < ops.length; i++) // Read DOM
        endOperation_finish(ops[i]);
    }
  
    function endOperation_R1(op) {
      var cm = op.cm, display = cm.display;
      maybeClipScrollbars(cm);
      if (op.updateMaxLine) findMaxLine(cm);
  
      op.mustUpdate = op.viewChanged || op.forceUpdate || op.scrollTop != null ||
        op.scrollToPos && (op.scrollToPos.from.line < display.viewFrom ||
                           op.scrollToPos.to.line >= display.viewTo) ||
        display.maxLineChanged && cm.options.lineWrapping;
      op.update = op.mustUpdate &&
        new DisplayUpdate(cm, op.mustUpdate && {top: op.scrollTop, ensure: op.scrollToPos}, op.forceUpdate);
    }
  
    function endOperation_W1(op) {
      op.updatedDisplay = op.mustUpdate && updateDisplayIfNeeded(op.cm, op.update);
    }
  
    function endOperation_R2(op) {
      var cm = op.cm, display = cm.display;
      if (op.updatedDisplay) updateHeightsInViewport(cm);
  
      op.barMeasure = measureForScrollbars(cm);
  
      // If the max line changed since it was last measured, measure it,
      // and ensure the document's width matches it.
      // updateDisplay_W2 will use these properties to do the actual resizing
      if (display.maxLineChanged && !cm.options.lineWrapping) {
        op.adjustWidthTo = measureChar(cm, display.maxLine, display.maxLine.text.length).left + 3;
        cm.display.sizerWidth = op.adjustWidthTo;
        op.barMeasure.scrollWidth =
          Math.max(display.scroller.clientWidth, display.sizer.offsetLeft + op.adjustWidthTo + scrollGap(cm) + cm.display.barWidth);
        op.maxScrollLeft = Math.max(0, display.sizer.offsetLeft + op.adjustWidthTo - displayWidth(cm));
      }
  
      if (op.updatedDisplay || op.selectionChanged)
        op.preparedSelection = display.input.prepareSelection();
    }
  
    function endOperation_W2(op) {
      var cm = op.cm;
  
      if (op.adjustWidthTo != null) {
        cm.display.sizer.style.minWidth = op.adjustWidthTo + "px";
        if (op.maxScrollLeft < cm.doc.scrollLeft)
          setScrollLeft(cm, Math.min(cm.display.scroller.scrollLeft, op.maxScrollLeft), true);
        cm.display.maxLineChanged = false;
      }
  
      if (op.preparedSelection)
        cm.display.input.showSelection(op.preparedSelection);
      if (op.updatedDisplay)
        setDocumentHeight(cm, op.barMeasure);
      if (op.updatedDisplay || op.startHeight != cm.doc.height)
        updateScrollbars(cm, op.barMeasure);
  
      if (op.selectionChanged) restartBlink(cm);
  
      if (cm.state.focused && op.updateInput)
        cm.display.input.reset(op.typing);
      if (op.focus && op.focus == activeElt()) ensureFocus(op.cm);
    }
  
    function endOperation_finish(op) {
      var cm = op.cm, display = cm.display, doc = cm.doc;
  
      if (op.updatedDisplay) postUpdateDisplay(cm, op.update);
  
      // Abort mouse wheel delta measurement, when scrolling explicitly
      if (display.wheelStartX != null && (op.scrollTop != null || op.scrollLeft != null || op.scrollToPos))
        display.wheelStartX = display.wheelStartY = null;
  
      // Propagate the scroll position to the actual DOM scroller
      if (op.scrollTop != null && (display.scroller.scrollTop != op.scrollTop || op.forceScroll)) {
        doc.scrollTop = Math.max(0, Math.min(display.scroller.scrollHeight - display.scroller.clientHeight, op.scrollTop));
        display.scrollbars.setScrollTop(doc.scrollTop);
        display.scroller.scrollTop = doc.scrollTop;
      }
      if (op.scrollLeft != null && (display.scroller.scrollLeft != op.scrollLeft || op.forceScroll)) {
        doc.scrollLeft = Math.max(0, Math.min(display.scroller.scrollWidth - displayWidth(cm), op.scrollLeft));
        display.scrollbars.setScrollLeft(doc.scrollLeft);
        display.scroller.scrollLeft = doc.scrollLeft;
        alignHorizontally(cm);
      }
      // If we need to scroll a specific position into view, do so.
      if (op.scrollToPos) {
        var coords = scrollPosIntoView(cm, clipPos(doc, op.scrollToPos.from),
                                       clipPos(doc, op.scrollToPos.to), op.scrollToPos.margin);
        if (op.scrollToPos.isCursor && cm.state.focused) maybeScrollWindow(cm, coords);
      }
  
      // Fire events for markers that are hidden/unidden by editing or
      // undoing
      var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
      if (hidden) for (var i = 0; i < hidden.length; ++i)
        if (!hidden[i].lines.length) signal(hidden[i], "hide");
      if (unhidden) for (var i = 0; i < unhidden.length; ++i)
        if (unhidden[i].lines.length) signal(unhidden[i], "unhide");
  
      if (display.wrapper.offsetHeight)
        doc.scrollTop = cm.display.scroller.scrollTop;
  
      // Fire change events, and delayed event handlers
      if (op.changeObjs)
        signal(cm, "changes", cm, op.changeObjs);
      if (op.update)
        op.update.finish();
    }
  
    // Run the given function in an operation
    function runInOp(cm, f) {
      if (cm.curOp) return f();
      startOperation(cm);
      try { return f(); }
      finally { endOperation(cm); }
    }
    // Wraps a function in an operation. Returns the wrapped function.
    function operation(cm, f) {
      return function() {
        if (cm.curOp) return f.apply(cm, arguments);
        startOperation(cm);
        try { return f.apply(cm, arguments); }
        finally { endOperation(cm); }
      };
    }
    // Used to add methods to editor and doc instances, wrapping them in
    // operations.
    function methodOp(f) {
      return function() {
        if (this.curOp) return f.apply(this, arguments);
        startOperation(this);
        try { return f.apply(this, arguments); }
        finally { endOperation(this); }
      };
    }
    function docMethodOp(f) {
      return function() {
        var cm = this.cm;
        if (!cm || cm.curOp) return f.apply(this, arguments);
        startOperation(cm);
        try { return f.apply(this, arguments); }
        finally { endOperation(cm); }
      };
    }
  
    // VIEW TRACKING
  
    // These objects are used to represent the visible (currently drawn)
    // part of the document. A LineView may correspond to multiple
    // logical lines, if those are connected by collapsed ranges.
    function LineView(doc, line, lineN) {
      // The starting line
      this.line = line;
      // Continuing lines, if any
      this.rest = visualLineContinued(line);
      // Number of logical lines in this visual line
      this.size = this.rest ? lineNo(lst(this.rest)) - lineN + 1 : 1;
      this.node = this.text = null;
      this.hidden = lineIsHidden(doc, line);
    }
  
    // Create a range of LineView objects for the given lines.
    function buildViewArray(cm, from, to) {
      var array = [], nextPos;
      for (var pos = from; pos < to; pos = nextPos) {
        var view = new LineView(cm.doc, getLine(cm.doc, pos), pos);
        nextPos = pos + view.size;
        array.push(view);
      }
      return array;
    }
  
    // Updates the display.view data structure for a given change to the
    // document. From and to are in pre-change coordinates. Lendiff is
    // the amount of lines added or subtracted by the change. This is
    // used for changes that span multiple lines, or change the way
    // lines are divided into visual lines. regLineChange (below)
    // registers single-line changes.
    function regChange(cm, from, to, lendiff) {
      if (from == null) from = cm.doc.first;
      if (to == null) to = cm.doc.first + cm.doc.size;
      if (!lendiff) lendiff = 0;
  
      var display = cm.display;
      if (lendiff && to < display.viewTo &&
          (display.updateLineNumbers == null || display.updateLineNumbers > from))
        display.updateLineNumbers = from;
  
      cm.curOp.viewChanged = true;
  
      if (from >= display.viewTo) { // Change after
        if (sawCollapsedSpans && visualLineNo(cm.doc, from) < display.viewTo)
          resetView(cm);
      } else if (to <= display.viewFrom) { // Change before
        if (sawCollapsedSpans && visualLineEndNo(cm.doc, to + lendiff) > display.viewFrom) {
          resetView(cm);
        } else {
          display.viewFrom += lendiff;
          display.viewTo += lendiff;
        }
      } else if (from <= display.viewFrom && to >= display.viewTo) { // Full overlap
        resetView(cm);
      } else if (from <= display.viewFrom) { // Top overlap
        var cut = viewCuttingPoint(cm, to, to + lendiff, 1);
        if (cut) {
          display.view = display.view.slice(cut.index);
          display.viewFrom = cut.lineN;
          display.viewTo += lendiff;
        } else {
          resetView(cm);
        }
      } else if (to >= display.viewTo) { // Bottom overlap
        var cut = viewCuttingPoint(cm, from, from, -1);
        if (cut) {
          display.view = display.view.slice(0, cut.index);
          display.viewTo = cut.lineN;
        } else {
          resetView(cm);
        }
      } else { // Gap in the middle
        var cutTop = viewCuttingPoint(cm, from, from, -1);
        var cutBot = viewCuttingPoint(cm, to, to + lendiff, 1);
        if (cutTop && cutBot) {
          display.view = display.view.slice(0, cutTop.index)
            .concat(buildViewArray(cm, cutTop.lineN, cutBot.lineN))
            .concat(display.view.slice(cutBot.index));
          display.viewTo += lendiff;
        } else {
          resetView(cm);
        }
      }
  
      var ext = display.externalMeasured;
      if (ext) {
        if (to < ext.lineN)
          ext.lineN += lendiff;
        else if (from < ext.lineN + ext.size)
          display.externalMeasured = null;
      }
    }
  
    // Register a change to a single line. Type must be one of "text",
    // "gutter", "class", "widget"
    function regLineChange(cm, line, type) {
      cm.curOp.viewChanged = true;
      var display = cm.display, ext = cm.display.externalMeasured;
      if (ext && line >= ext.lineN && line < ext.lineN + ext.size)
        display.externalMeasured = null;
  
      if (line < display.viewFrom || line >= display.viewTo) return;
      var lineView = display.view[findViewIndex(cm, line)];
      if (lineView.node == null) return;
      var arr = lineView.changes || (lineView.changes = []);
      if (indexOf(arr, type) == -1) arr.push(type);
    }
  
    // Clear the view.
    function resetView(cm) {
      cm.display.viewFrom = cm.display.viewTo = cm.doc.first;
      cm.display.view = [];
      cm.display.viewOffset = 0;
    }
  
    // Find the view element corresponding to a given line. Return null
    // when the line isn't visible.
    function findViewIndex(cm, n) {
      if (n >= cm.display.viewTo) return null;
      n -= cm.display.viewFrom;
      if (n < 0) return null;
      var view = cm.display.view;
      for (var i = 0; i < view.length; i++) {
        n -= view[i].size;
        if (n < 0) return i;
      }
    }
  
    function viewCuttingPoint(cm, oldN, newN, dir) {
      var index = findViewIndex(cm, oldN), diff, view = cm.display.view;
      if (!sawCollapsedSpans || newN == cm.doc.first + cm.doc.size)
        return {index: index, lineN: newN};
      for (var i = 0, n = cm.display.viewFrom; i < index; i++)
        n += view[i].size;
      if (n != oldN) {
        if (dir > 0) {
          if (index == view.length - 1) return null;
          diff = (n + view[index].size) - oldN;
          index++;
        } else {
          diff = n - oldN;
        }
        oldN += diff; newN += diff;
      }
      while (visualLineNo(cm.doc, newN) != newN) {
        if (index == (dir < 0 ? 0 : view.length - 1)) return null;
        newN += dir * view[index - (dir < 0 ? 1 : 0)].size;
        index += dir;
      }
      return {index: index, lineN: newN};
    }
  
    // Force the view to cover a given range, adding empty view element
    // or clipping off existing ones as needed.
    function adjustView(cm, from, to) {
      var display = cm.display, view = display.view;
      if (view.length == 0 || from >= display.viewTo || to <= display.viewFrom) {
        display.view = buildViewArray(cm, from, to);
        display.viewFrom = from;
      } else {
        if (display.viewFrom > from)
          display.view = buildViewArray(cm, from, display.viewFrom).concat(display.view);
        else if (display.viewFrom < from)
          display.view = display.view.slice(findViewIndex(cm, from));
        display.viewFrom = from;
        if (display.viewTo < to)
          display.view = display.view.concat(buildViewArray(cm, display.viewTo, to));
        else if (display.viewTo > to)
          display.view = display.view.slice(0, findViewIndex(cm, to));
      }
      display.viewTo = to;
    }
  
    // Count the number of lines in the view whose DOM representation is
    // out of date (or nonexistent).
    function countDirtyView(cm) {
      var view = cm.display.view, dirty = 0;
      for (var i = 0; i < view.length; i++) {
        var lineView = view[i];
        if (!lineView.hidden && (!lineView.node || lineView.changes)) ++dirty;
      }
      return dirty;
    }
  
    // EVENT HANDLERS
  
    // Attach the necessary event handlers when initializing the editor
    function registerEventHandlers(cm) {
      var d = cm.display;
      on(d.scroller, "mousedown", operation(cm, onMouseDown));
      // Older IE's will not fire a second mousedown for a double click
      if (ie && ie_version < 11)
        on(d.scroller, "dblclick", operation(cm, function(e) {
          if (signalDOMEvent(cm, e)) return;
          var pos = posFromMouse(cm, e);
          if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
          e_preventDefault(e);
          var word = cm.findWordAt(pos);
          extendSelection(cm.doc, word.anchor, word.head);
        }));
      else
        on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
      // Some browsers fire contextmenu *after* opening the menu, at
      // which point we can't mess with it anymore. Context menu is
      // handled in onMouseDown for these browsers.
      if (!captureRightClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});
  
      // Used to suppress mouse event handling when a touch happens
      var touchFinished, prevTouch = {end: 0};
      function finishTouch() {
        if (d.activeTouch) {
          touchFinished = setTimeout(function() {d.activeTouch = null;}, 1000);
          prevTouch = d.activeTouch;
          prevTouch.end = +new Date;
        }
      };
      function isMouseLikeTouchEvent(e) {
        if (e.touches.length != 1) return false;
        var touch = e.touches[0];
        return touch.radiusX <= 1 && touch.radiusY <= 1;
      }
      function farAway(touch, other) {
        if (other.left == null) return true;
        var dx = other.left - touch.left, dy = other.top - touch.top;
        return dx * dx + dy * dy > 20 * 20;
      }
      on(d.scroller, "touchstart", function(e) {
        if (!isMouseLikeTouchEvent(e)) {
          clearTimeout(touchFinished);
          var now = +new Date;
          d.activeTouch = {start: now, moved: false,
                           prev: now - prevTouch.end <= 300 ? prevTouch : null};
          if (e.touches.length == 1) {
            d.activeTouch.left = e.touches[0].pageX;
            d.activeTouch.top = e.touches[0].pageY;
          }
        }
      });
      on(d.scroller, "touchmove", function() {
        if (d.activeTouch) d.activeTouch.moved = true;
      });
      on(d.scroller, "touchend", function(e) {
        var touch = d.activeTouch;
        if (touch && !eventInWidget(d, e) && touch.left != null &&
            !touch.moved && new Date - touch.start < 300) {
          var pos = cm.coordsChar(d.activeTouch, "page"), range;
          if (!touch.prev || farAway(touch, touch.prev)) // Single tap
            range = new Range(pos, pos);
          else if (!touch.prev.prev || farAway(touch, touch.prev.prev)) // Double tap
            range = cm.findWordAt(pos);
          else // Triple tap
            range = new Range(Pos(pos.line, 0), clipPos(cm.doc, Pos(pos.line + 1, 0)));
          cm.setSelection(range.anchor, range.head);
          cm.focus();
          e_preventDefault(e);
        }
        finishTouch();
      });
      on(d.scroller, "touchcancel", finishTouch);
  
      // Sync scrolling between fake scrollbars and real scrollable
      // area, ensure viewport is updated when scrolling.
      on(d.scroller, "scroll", function() {
        if (d.scroller.clientHeight) {
          setScrollTop(cm, d.scroller.scrollTop);
          setScrollLeft(cm, d.scroller.scrollLeft, true);
          signal(cm, "scroll", cm);
        }
      });
  
      // Listen to wheel events in order to try and update the viewport on time.
      on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
      on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});
  
      // Prevent wrapper from ever scrolling
      on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });
  
      d.dragFunctions = {
        simple: function(e) {if (!signalDOMEvent(cm, e)) e_stop(e);},
        start: function(e){onDragStart(cm, e);},
        drop: operation(cm, onDrop)
      };
  
      var inp = d.input.getField();
      on(inp, "keyup", function(e) { onKeyUp.call(cm, e); });
      on(inp, "keydown", operation(cm, onKeyDown));
      on(inp, "keypress", operation(cm, onKeyPress));
      on(inp, "focus", bind(onFocus, cm));
      on(inp, "blur", bind(onBlur, cm));
    }
  
    function dragDropChanged(cm, value, old) {
      var wasOn = old && old != CodeMirror.Init;
      if (!value != !wasOn) {
        var funcs = cm.display.dragFunctions;
        var toggle = value ? on : off;
        toggle(cm.display.scroller, "dragstart", funcs.start);
        toggle(cm.display.scroller, "dragenter", funcs.simple);
        toggle(cm.display.scroller, "dragover", funcs.simple);
        toggle(cm.display.scroller, "drop", funcs.drop);
      }
    }
  
    // Called when the window resizes
    function onResize(cm) {
      var d = cm.display;
      if (d.lastWrapHeight == d.wrapper.clientHeight && d.lastWrapWidth == d.wrapper.clientWidth)
        return;
      // Might be a text scaling operation, clear size caches.
      d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
      d.scrollbarsClipped = false;
      cm.setSize();
    }
  
    // MOUSE EVENTS
  
    // Return true when the given mouse event happened in a widget
    function eventInWidget(display, e) {
      for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
        if (!n || (n.nodeType == 1 && n.getAttribute("cm-ignore-events") == "true") ||
            (n.parentNode == display.sizer && n != display.mover))
          return true;
      }
    }
  
    // Given a mouse event, find the corresponding position. If liberal
    // is false, it checks whether a gutter or scrollbar was clicked,
    // and returns null if it was. forRect is used by rectangular
    // selections, and tries to estimate a character position even for
    // coordinates beyond the right of the text.
    function posFromMouse(cm, e, liberal, forRect) {
      var display = cm.display;
      if (!liberal && e_target(e).getAttribute("cm-not-content") == "true") return null;
  
      var x, y, space = display.lineSpace.getBoundingClientRect();
      // Fails unpredictably on IE[67] when mouse is dragged around quickly.
      try { x = e.clientX - space.left; y = e.clientY - space.top; }
      catch (e) { return null; }
      var coords = coordsChar(cm, x, y), line;
      if (forRect && coords.xRel == 1 && (line = getLine(cm.doc, coords.line).text).length == coords.ch) {
        var colDiff = countColumn(line, line.length, cm.options.tabSize) - line.length;
        coords = Pos(coords.line, Math.max(0, Math.round((x - paddingH(cm.display).left) / charWidth(cm.display)) - colDiff));
      }
      return coords;
    }
  
    // A mouse down can be a single click, double click, triple click,
    // start of selection drag, start of text drag, new cursor
    // (ctrl-click), rectangle drag (alt-drag), or xwin
    // middle-click-paste. Or it might be a click on something we should
    // not interfere with, such as a scrollbar or widget.
    function onMouseDown(e) {
      var cm = this, display = cm.display;
      if (display.activeTouch && display.input.supportsTouch() || signalDOMEvent(cm, e)) return;
      display.shift = e.shiftKey;
  
      if (eventInWidget(display, e)) {
        if (!webkit) {
          // Briefly turn off draggability, to allow widgets to do
          // normal dragging things.
          display.scroller.draggable = false;
          setTimeout(function(){display.scroller.draggable = true;}, 100);
        }
        return;
      }
      if (clickInGutter(cm, e)) return;
      var start = posFromMouse(cm, e);
      window.focus();
  
      switch (e_button(e)) {
      case 1:
        if (start)
          leftButtonDown(cm, e, start);
        else if (e_target(e) == display.scroller)
          e_preventDefault(e);
        break;
      case 2:
        if (webkit) cm.state.lastMiddleDown = +new Date;
        if (start) extendSelection(cm.doc, start);
        setTimeout(function() {display.input.focus();}, 20);
        e_preventDefault(e);
        break;
      case 3:
        if (captureRightClick) onContextMenu(cm, e);
        else delayBlurEvent(cm);
        break;
      }
    }
  
    var lastClick, lastDoubleClick;
    function leftButtonDown(cm, e, start) {
      if (ie) setTimeout(bind(ensureFocus, cm), 0);
      else cm.curOp.focus = activeElt();
  
      var now = +new Date, type;
      if (lastDoubleClick && lastDoubleClick.time > now - 400 && cmp(lastDoubleClick.pos, start) == 0) {
        type = "triple";
      } else if (lastClick && lastClick.time > now - 400 && cmp(lastClick.pos, start) == 0) {
        type = "double";
        lastDoubleClick = {time: now, pos: start};
      } else {
        type = "single";
        lastClick = {time: now, pos: start};
      }
  
      var sel = cm.doc.sel, modifier = mac ? e.metaKey : e.ctrlKey, contained;
      if (cm.options.dragDrop && dragAndDrop && !isReadOnly(cm) &&
          type == "single" && (contained = sel.contains(start)) > -1 &&
          (cmp((contained = sel.ranges[contained]).from(), start) < 0 || start.xRel > 0) &&
          (cmp(contained.to(), start) > 0 || start.xRel < 0))
        leftButtonStartDrag(cm, e, start, modifier);
      else
        leftButtonSelect(cm, e, start, type, modifier);
    }
  
    // Start a text drag. When it ends, see if any dragging actually
    // happen, and treat as a click if it didn't.
    function leftButtonStartDrag(cm, e, start, modifier) {
      var display = cm.display, startTime = +new Date;
      var dragEnd = operation(cm, function(e2) {
        if (webkit) display.scroller.draggable = false;
        cm.state.draggingText = false;
        off(document, "mouseup", dragEnd);
        off(display.scroller, "drop", dragEnd);
        if (Math.abs(e.clientX - e2.clientX) + Math.abs(e.clientY - e2.clientY) < 10) {
          e_preventDefault(e2);
          if (!modifier && +new Date - 200 < startTime)
            extendSelection(cm.doc, start);
          // Work around unexplainable focus problem in IE9 (#2127) and Chrome (#3081)
          if (webkit || ie && ie_version == 9)
            setTimeout(function() {document.body.focus(); display.input.focus();}, 20);
          else
            display.input.focus();
        }
      });
      // Let the drag handler handle this.
      if (webkit) display.scroller.draggable = true;
      cm.state.draggingText = dragEnd;
      // IE's approach to draggable
      if (display.scroller.dragDrop) display.scroller.dragDrop();
      on(document, "mouseup", dragEnd);
      on(display.scroller, "drop", dragEnd);
    }
  
    // Normal selection, as opposed to text dragging.
    function leftButtonSelect(cm, e, start, type, addNew) {
      var display = cm.display, doc = cm.doc;
      e_preventDefault(e);
  
      var ourRange, ourIndex, startSel = doc.sel, ranges = startSel.ranges;
      if (addNew && !e.shiftKey) {
        ourIndex = doc.sel.contains(start);
        if (ourIndex > -1)
          ourRange = ranges[ourIndex];
        else
          ourRange = new Range(start, start);
      } else {
        ourRange = doc.sel.primary();
        ourIndex = doc.sel.primIndex;
      }
  
      if (e.altKey) {
        type = "rect";
        if (!addNew) ourRange = new Range(start, start);
        start = posFromMouse(cm, e, true, true);
        ourIndex = -1;
      } else if (type == "double") {
        var word = cm.findWordAt(start);
        if (cm.display.shift || doc.extend)
          ourRange = extendRange(doc, ourRange, word.anchor, word.head);
        else
          ourRange = word;
      } else if (type == "triple") {
        var line = new Range(Pos(start.line, 0), clipPos(doc, Pos(start.line + 1, 0)));
        if (cm.display.shift || doc.extend)
          ourRange = extendRange(doc, ourRange, line.anchor, line.head);
        else
          ourRange = line;
      } else {
        ourRange = extendRange(doc, ourRange, start);
      }
  
      if (!addNew) {
        ourIndex = 0;
        setSelection(doc, new Selection([ourRange], 0), sel_mouse);
        startSel = doc.sel;
      } else if (ourIndex == -1) {
        ourIndex = ranges.length;
        setSelection(doc, normalizeSelection(ranges.concat([ourRange]), ourIndex),
                     {scroll: false, origin: "*mouse"});
      } else if (ranges.length > 1 && ranges[ourIndex].empty() && type == "single" && !e.shiftKey) {
        setSelection(doc, normalizeSelection(ranges.slice(0, ourIndex).concat(ranges.slice(ourIndex + 1)), 0));
        startSel = doc.sel;
      } else {
        replaceOneSelection(doc, ourIndex, ourRange, sel_mouse);
      }
  
      var lastPos = start;
      function extendTo(pos) {
        if (cmp(lastPos, pos) == 0) return;
        lastPos = pos;
  
        if (type == "rect") {
          var ranges = [], tabSize = cm.options.tabSize;
          var startCol = countColumn(getLine(doc, start.line).text, start.ch, tabSize);
          var posCol = countColumn(getLine(doc, pos.line).text, pos.ch, tabSize);
          var left = Math.min(startCol, posCol), right = Math.max(startCol, posCol);
          for (var line = Math.min(start.line, pos.line), end = Math.min(cm.lastLine(), Math.max(start.line, pos.line));
               line <= end; line++) {
            var text = getLine(doc, line).text, leftPos = findColumn(text, left, tabSize);
            if (left == right)
              ranges.push(new Range(Pos(line, leftPos), Pos(line, leftPos)));
            else if (text.length > leftPos)
              ranges.push(new Range(Pos(line, leftPos), Pos(line, findColumn(text, right, tabSize))));
          }
          if (!ranges.length) ranges.push(new Range(start, start));
          setSelection(doc, normalizeSelection(startSel.ranges.slice(0, ourIndex).concat(ranges), ourIndex),
                       {origin: "*mouse", scroll: false});
          cm.scrollIntoView(pos);
        } else {
          var oldRange = ourRange;
          var anchor = oldRange.anchor, head = pos;
          if (type != "single") {
            if (type == "double")
              var range = cm.findWordAt(pos);
            else
              var range = new Range(Pos(pos.line, 0), clipPos(doc, Pos(pos.line + 1, 0)));
            if (cmp(range.anchor, anchor) > 0) {
              head = range.head;
              anchor = minPos(oldRange.from(), range.anchor);
            } else {
              head = range.anchor;
              anchor = maxPos(oldRange.to(), range.head);
            }
          }
          var ranges = startSel.ranges.slice(0);
          ranges[ourIndex] = new Range(clipPos(doc, anchor), head);
          setSelection(doc, normalizeSelection(ranges, ourIndex), sel_mouse);
        }
      }
  
      var editorSize = display.wrapper.getBoundingClientRect();
      // Used to ensure timeout re-tries don't fire when another extend
      // happened in the meantime (clearTimeout isn't reliable -- at
      // least on Chrome, the timeouts still happen even when cleared,
      // if the clear happens after their scheduled firing time).
      var counter = 0;
  
      function extend(e) {
        var curCount = ++counter;
        var cur = posFromMouse(cm, e, true, type == "rect");
        if (!cur) return;
        if (cmp(cur, lastPos) != 0) {
          cm.curOp.focus = activeElt();
          extendTo(cur);
          var visible = visibleLines(display, doc);
          if (cur.line >= visible.to || cur.line < visible.from)
            setTimeout(operation(cm, function(){if (counter == curCount) extend(e);}), 150);
        } else {
          var outside = e.clientY < editorSize.top ? -20 : e.clientY > editorSize.bottom ? 20 : 0;
          if (outside) setTimeout(operation(cm, function() {
            if (counter != curCount) return;
            display.scroller.scrollTop += outside;
            extend(e);
          }), 50);
        }
      }
  
      function done(e) {
        counter = Infinity;
        e_preventDefault(e);
        display.input.focus();
        off(document, "mousemove", move);
        off(document, "mouseup", up);
        doc.history.lastSelOrigin = null;
      }
  
      var move = operation(cm, function(e) {
        if (!e_button(e)) done(e);
        else extend(e);
      });
      var up = operation(cm, done);
      on(document, "mousemove", move);
      on(document, "mouseup", up);
    }
  
    // Determines whether an event happened in the gutter, and fires the
    // handlers for the corresponding event.
    function gutterEvent(cm, e, type, prevent, signalfn) {
      try { var mX = e.clientX, mY = e.clientY; }
      catch(e) { return false; }
      if (mX >= Math.floor(cm.display.gutters.getBoundingClientRect().right)) return false;
      if (prevent) e_preventDefault(e);
  
      var display = cm.display;
      var lineBox = display.lineDiv.getBoundingClientRect();
  
      if (mY > lineBox.bottom || !hasHandler(cm, type)) return e_defaultPrevented(e);
      mY -= lineBox.top - display.viewOffset;
  
      for (var i = 0; i < cm.options.gutters.length; ++i) {
        var g = display.gutters.childNodes[i];
        if (g && g.getBoundingClientRect().right >= mX) {
          var line = lineAtHeight(cm.doc, mY);
          var gutter = cm.options.gutters[i];
          signalfn(cm, type, cm, line, gutter, e);
          return e_defaultPrevented(e);
        }
      }
    }
  
    function clickInGutter(cm, e) {
      return gutterEvent(cm, e, "gutterClick", true, signalLater);
    }
  
    // Kludge to work around strange IE behavior where it'll sometimes
    // re-fire a series of drag-related events right after the drop (#1551)
    var lastDrop = 0;
  
    function onDrop(e) {
      var cm = this;
      if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e))
        return;
      e_preventDefault(e);
      if (ie) lastDrop = +new Date;
      var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
      if (!pos || isReadOnly(cm)) return;
      // Might be a file drop, in which case we simply extract the text
      // and insert it.
      if (files && files.length && window.FileReader && window.File) {
        var n = files.length, text = Array(n), read = 0;
        var loadFile = function(file, i) {
          var reader = new FileReader;
          reader.onload = operation(cm, function() {
            text[i] = reader.result;
            if (++read == n) {
              pos = clipPos(cm.doc, pos);
              var change = {from: pos, to: pos,
                            text: cm.doc.splitLines(text.join(cm.doc.lineSeparator())),
                            origin: "paste"};
              makeChange(cm.doc, change);
              setSelectionReplaceHistory(cm.doc, simpleSelection(pos, changeEnd(change)));
            }
          });
          reader.readAsText(file);
        };
        for (var i = 0; i < n; ++i) loadFile(files[i], i);
      } else { // Normal drop
        // Don't do a replace if the drop happened inside of the selected text.
        if (cm.state.draggingText && cm.doc.sel.contains(pos) > -1) {
          cm.state.draggingText(e);
          // Ensure the editor is re-focused
          setTimeout(function() {cm.display.input.focus();}, 20);
          return;
        }
        try {
          var text = e.dataTransfer.getData("Text");
          if (text) {
            if (cm.state.draggingText && !(mac ? e.altKey : e.ctrlKey))
              var selected = cm.listSelections();
            setSelectionNoUndo(cm.doc, simpleSelection(pos, pos));
            if (selected) for (var i = 0; i < selected.length; ++i)
              replaceRange(cm.doc, "", selected[i].anchor, selected[i].head, "drag");
            cm.replaceSelection(text, "around", "paste");
            cm.display.input.focus();
          }
        }
        catch(e){}
      }
    }
  
    function onDragStart(cm, e) {
      if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return; }
      if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) return;
  
      e.dataTransfer.setData("Text", cm.getSelection());
  
      // Use dummy image instead of default browsers image.
      // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
      if (e.dataTransfer.setDragImage && !safari) {
        var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
        img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
        if (presto) {
          img.width = img.height = 1;
          cm.display.wrapper.appendChild(img);
          // Force a relayout, or Opera won't use our image for some obscure reason
          img._top = img.offsetTop;
        }
        e.dataTransfer.setDragImage(img, 0, 0);
        if (presto) img.parentNode.removeChild(img);
      }
    }
  
    // SCROLL EVENTS
  
    // Sync the scrollable area and scrollbars, ensure the viewport
    // covers the visible area.
    function setScrollTop(cm, val) {
      if (Math.abs(cm.doc.scrollTop - val) < 2) return;
      cm.doc.scrollTop = val;
      if (!gecko) updateDisplaySimple(cm, {top: val});
      if (cm.display.scroller.scrollTop != val) cm.display.scroller.scrollTop = val;
      cm.display.scrollbars.setScrollTop(val);
      if (gecko) updateDisplaySimple(cm);
      startWorker(cm, 100);
    }
    // Sync scroller and scrollbar, ensure the gutter elements are
    // aligned.
    function setScrollLeft(cm, val, isScroller) {
      if (isScroller ? val == cm.doc.scrollLeft : Math.abs(cm.doc.scrollLeft - val) < 2) return;
      val = Math.min(val, cm.display.scroller.scrollWidth - cm.display.scroller.clientWidth);
      cm.doc.scrollLeft = val;
      alignHorizontally(cm);
      if (cm.display.scroller.scrollLeft != val) cm.display.scroller.scrollLeft = val;
      cm.display.scrollbars.setScrollLeft(val);
    }
  
    // Since the delta values reported on mouse wheel events are
    // unstandardized between browsers and even browser versions, and
    // generally horribly unpredictable, this code starts by measuring
    // the scroll effect that the first few mouse wheel events have,
    // and, from that, detects the way it can convert deltas to pixel
    // offsets afterwards.
    //
    // The reason we want to know the amount a wheel event will scroll
    // is that it gives us a chance to update the display before the
    // actual scrolling happens, reducing flickering.
  
    var wheelSamples = 0, wheelPixelsPerUnit = null;
    // Fill in a browser-detected starting value on browsers where we
    // know one. These don't have to be accurate -- the result of them
    // being wrong would just be a slight flicker on the first wheel
    // scroll (if it is large enough).
    if (ie) wheelPixelsPerUnit = -.53;
    else if (gecko) wheelPixelsPerUnit = 15;
    else if (chrome) wheelPixelsPerUnit = -.7;
    else if (safari) wheelPixelsPerUnit = -1/3;
  
    var wheelEventDelta = function(e) {
      var dx = e.wheelDeltaX, dy = e.wheelDeltaY;
      if (dx == null && e.detail && e.axis == e.HORIZONTAL_AXIS) dx = e.detail;
      if (dy == null && e.detail && e.axis == e.VERTICAL_AXIS) dy = e.detail;
      else if (dy == null) dy = e.wheelDelta;
      return {x: dx, y: dy};
    };
    CodeMirror.wheelEventPixels = function(e) {
      var delta = wheelEventDelta(e);
      delta.x *= wheelPixelsPerUnit;
      delta.y *= wheelPixelsPerUnit;
      return delta;
    };
  
    function onScrollWheel(cm, e) {
      var delta = wheelEventDelta(e), dx = delta.x, dy = delta.y;
  
      var display = cm.display, scroll = display.scroller;
      // Quit if there's nothing to scroll here
      if (!(dx && scroll.scrollWidth > scroll.clientWidth ||
            dy && scroll.scrollHeight > scroll.clientHeight)) return;
  
      // Webkit browsers on OS X abort momentum scrolls when the target
      // of the scroll event is removed from the scrollable element.
      // This hack (see related code in patchDisplay) makes sure the
      // element is kept around.
      if (dy && mac && webkit) {
        outer: for (var cur = e.target, view = display.view; cur != scroll; cur = cur.parentNode) {
          for (var i = 0; i < view.length; i++) {
            if (view[i].node == cur) {
              cm.display.currentWheelTarget = cur;
              break outer;
            }
          }
        }
      }
  
      // On some browsers, horizontal scrolling will cause redraws to
      // happen before the gutter has been realigned, causing it to
      // wriggle around in a most unseemly way. When we have an
      // estimated pixels/delta value, we just handle horizontal
      // scrolling entirely here. It'll be slightly off from native, but
      // better than glitching out.
      if (dx && !gecko && !presto && wheelPixelsPerUnit != null) {
        if (dy)
          setScrollTop(cm, Math.max(0, Math.min(scroll.scrollTop + dy * wheelPixelsPerUnit, scroll.scrollHeight - scroll.clientHeight)));
        setScrollLeft(cm, Math.max(0, Math.min(scroll.scrollLeft + dx * wheelPixelsPerUnit, scroll.scrollWidth - scroll.clientWidth)));
        e_preventDefault(e);
        display.wheelStartX = null; // Abort measurement, if in progress
        return;
      }
  
      // 'Project' the visible viewport to cover the area that is being
      // scrolled into view (if we know enough to estimate it).
      if (dy && wheelPixelsPerUnit != null) {
        var pixels = dy * wheelPixelsPerUnit;
        var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
        if (pixels < 0) top = Math.max(0, top + pixels - 50);
        else bot = Math.min(cm.doc.height, bot + pixels + 50);
        updateDisplaySimple(cm, {top: top, bottom: bot});
      }
  
      if (wheelSamples < 20) {
        if (display.wheelStartX == null) {
          display.wheelStartX = scroll.scrollLeft; display.wheelStartY = scroll.scrollTop;
          display.wheelDX = dx; display.wheelDY = dy;
          setTimeout(function() {
            if (display.wheelStartX == null) return;
            var movedX = scroll.scrollLeft - display.wheelStartX;
            var movedY = scroll.scrollTop - display.wheelStartY;
            var sample = (movedY && display.wheelDY && movedY / display.wheelDY) ||
              (movedX && display.wheelDX && movedX / display.wheelDX);
            display.wheelStartX = display.wheelStartY = null;
            if (!sample) return;
            wheelPixelsPerUnit = (wheelPixelsPerUnit * wheelSamples + sample) / (wheelSamples + 1);
            ++wheelSamples;
          }, 200);
        } else {
          display.wheelDX += dx; display.wheelDY += dy;
        }
      }
    }
  
    // KEY EVENTS
  
    // Run a handler that was bound to a key.
    function doHandleBinding(cm, bound, dropShift) {
      if (typeof bound == "string") {
        bound = commands[bound];
        if (!bound) return false;
      }
      // Ensure previous input has been read, so that the handler sees a
      // consistent view of the document
      cm.display.input.ensurePolled();
      var prevShift = cm.display.shift, done = false;
      try {
        if (isReadOnly(cm)) cm.state.suppressEdits = true;
        if (dropShift) cm.display.shift = false;
        done = bound(cm) != Pass;
      } finally {
        cm.display.shift = prevShift;
        cm.state.suppressEdits = false;
      }
      return done;
    }
  
    function lookupKeyForEditor(cm, name, handle) {
      for (var i = 0; i < cm.state.keyMaps.length; i++) {
        var result = lookupKey(name, cm.state.keyMaps[i], handle, cm);
        if (result) return result;
      }
      return (cm.options.extraKeys && lookupKey(name, cm.options.extraKeys, handle, cm))
        || lookupKey(name, cm.options.keyMap, handle, cm);
    }
  
    var stopSeq = new Delayed;
    function dispatchKey(cm, name, e, handle) {
      var seq = cm.state.keySeq;
      if (seq) {
        if (isModifierKey(name)) return "handled";
        stopSeq.set(50, function() {
          if (cm.state.keySeq == seq) {
            cm.state.keySeq = null;
            cm.display.input.reset();
          }
        });
        name = seq + " " + name;
      }
      var result = lookupKeyForEditor(cm, name, handle);
  
      if (result == "multi")
        cm.state.keySeq = name;
      if (result == "handled")
        signalLater(cm, "keyHandled", cm, name, e);
  
      if (result == "handled" || result == "multi") {
        e_preventDefault(e);
        restartBlink(cm);
      }
  
      if (seq && !result && /\'$/.test(name)) {
        e_preventDefault(e);
        return true;
      }
      return !!result;
    }
  
    // Handle a key from the keydown event.
    function handleKeyBinding(cm, e) {
      var name = keyName(e, true);
      if (!name) return false;
  
      if (e.shiftKey && !cm.state.keySeq) {
        // First try to resolve full name (including 'Shift-'). Failing
        // that, see if there is a cursor-motion command (starting with
        // 'go') bound to the keyname without 'Shift-'.
        return dispatchKey(cm, "Shift-" + name, e, function(b) {return doHandleBinding(cm, b, true);})
            || dispatchKey(cm, name, e, function(b) {
                 if (typeof b == "string" ? /^go[A-Z]/.test(b) : b.motion)
                   return doHandleBinding(cm, b);
               });
      } else {
        return dispatchKey(cm, name, e, function(b) { return doHandleBinding(cm, b); });
      }
    }
  
    // Handle a key from the keypress event
    function handleCharBinding(cm, e, ch) {
      return dispatchKey(cm, "'" + ch + "'", e,
                         function(b) { return doHandleBinding(cm, b, true); });
    }
  
    var lastStoppedKey = null;
    function onKeyDown(e) {
      var cm = this;
      cm.curOp.focus = activeElt();
      if (signalDOMEvent(cm, e)) return;
      // IE does strange things with escape.
      if (ie && ie_version < 11 && e.keyCode == 27) e.returnValue = false;
      var code = e.keyCode;
      cm.display.shift = code == 16 || e.shiftKey;
      var handled = handleKeyBinding(cm, e);
      if (presto) {
        lastStoppedKey = handled ? code : null;
        // Opera has no cut event... we try to at least catch the key combo
        if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
          cm.replaceSelection("", null, "cut");
      }
  
      // Turn mouse into crosshair when Alt is held on Mac.
      if (code == 18 && !/\bCodeMirror-crosshair\b/.test(cm.display.lineDiv.className))
        showCrossHair(cm);
    }
  
    function showCrossHair(cm) {
      var lineDiv = cm.display.lineDiv;
      addClass(lineDiv, "CodeMirror-crosshair");
  
      function up(e) {
        if (e.keyCode == 18 || !e.altKey) {
          rmClass(lineDiv, "CodeMirror-crosshair");
          off(document, "keyup", up);
          off(document, "mouseover", up);
        }
      }
      on(document, "keyup", up);
      on(document, "mouseover", up);
    }
  
    function onKeyUp(e) {
      if (e.keyCode == 16) this.doc.sel.shift = false;
      signalDOMEvent(this, e);
    }
  
    function onKeyPress(e) {
      var cm = this;
      if (eventInWidget(cm.display, e) || signalDOMEvent(cm, e) || e.ctrlKey && !e.altKey || mac && e.metaKey) return;
      var keyCode = e.keyCode, charCode = e.charCode;
      if (presto && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return;}
      if ((presto && (!e.which || e.which < 10)) && handleKeyBinding(cm, e)) return;
      var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
      if (handleCharBinding(cm, e, ch)) return;
      cm.display.input.onKeyPress(e);
    }
  
    // FOCUS/BLUR EVENTS
  
    function delayBlurEvent(cm) {
      cm.state.delayingBlurEvent = true;
      setTimeout(function() {
        if (cm.state.delayingBlurEvent) {
          cm.state.delayingBlurEvent = false;
          onBlur(cm);
        }
      }, 100);
    }
  
    function onFocus(cm) {
      if (cm.state.delayingBlurEvent) cm.state.delayingBlurEvent = false;
  
      if (cm.options.readOnly == "nocursor") return;
      if (!cm.state.focused) {
        signal(cm, "focus", cm);
        cm.state.focused = true;
        addClass(cm.display.wrapper, "CodeMirror-focused");
        // This test prevents this from firing when a context
        // menu is closed (since the input reset would kill the
        // select-all detection hack)
        if (!cm.curOp && cm.display.selForContextMenu != cm.doc.sel) {
          cm.display.input.reset();
          if (webkit) setTimeout(function() { cm.display.input.reset(true); }, 20); // Issue #1730
        }
        cm.display.input.receivedFocus();
      }
      restartBlink(cm);
    }
    function onBlur(cm) {
      if (cm.state.delayingBlurEvent) return;
  
      if (cm.state.focused) {
        signal(cm, "blur", cm);
        cm.state.focused = false;
        rmClass(cm.display.wrapper, "CodeMirror-focused");
      }
      clearInterval(cm.display.blinker);
      setTimeout(function() {if (!cm.state.focused) cm.display.shift = false;}, 150);
    }
  
    // CONTEXT MENU HANDLING
  
    // To make the context menu work, we need to briefly unhide the
    // textarea (making it as unobtrusive as possible) to let the
    // right-click take effect on it.
    function onContextMenu(cm, e) {
      if (eventInWidget(cm.display, e) || contextMenuInGutter(cm, e)) return;
      cm.display.input.onContextMenu(e);
    }
  
    function contextMenuInGutter(cm, e) {
      if (!hasHandler(cm, "gutterContextMenu")) return false;
      return gutterEvent(cm, e, "gutterContextMenu", false, signal);
    }
  
    // UPDATING
  
    // Compute the position of the end of a change (its 'to' property
    // refers to the pre-change end).
    var changeEnd = CodeMirror.changeEnd = function(change) {
      if (!change.text) return change.to;
      return Pos(change.from.line + change.text.length - 1,
                 lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0));
    };
  
    // Adjust a position to refer to the post-change position of the
    // same text, or the end of the change if the change covers it.
    function adjustForChange(pos, change) {
      if (cmp(pos, change.from) < 0) return pos;
      if (cmp(pos, change.to) <= 0) return changeEnd(change);
  
      var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
      if (pos.line == change.to.line) ch += changeEnd(change).ch - change.to.ch;
      return Pos(line, ch);
    }
  
    function computeSelAfterChange(doc, change) {
      var out = [];
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        var range = doc.sel.ranges[i];
        out.push(new Range(adjustForChange(range.anchor, change),
                           adjustForChange(range.head, change)));
      }
      return normalizeSelection(out, doc.sel.primIndex);
    }
  
    function offsetPos(pos, old, nw) {
      if (pos.line == old.line)
        return Pos(nw.line, pos.ch - old.ch + nw.ch);
      else
        return Pos(nw.line + (pos.line - old.line), pos.ch);
    }
  
    // Used by replaceSelections to allow moving the selection to the
    // start or around the replaced test. Hint may be "start" or "around".
    function computeReplacedSel(doc, changes, hint) {
      var out = [];
      var oldPrev = Pos(doc.first, 0), newPrev = oldPrev;
      for (var i = 0; i < changes.length; i++) {
        var change = changes[i];
        var from = offsetPos(change.from, oldPrev, newPrev);
        var to = offsetPos(changeEnd(change), oldPrev, newPrev);
        oldPrev = change.to;
        newPrev = to;
        if (hint == "around") {
          var range = doc.sel.ranges[i], inv = cmp(range.head, range.anchor) < 0;
          out[i] = new Range(inv ? to : from, inv ? from : to);
        } else {
          out[i] = new Range(from, from);
        }
      }
      return new Selection(out, doc.sel.primIndex);
    }
  
    // Allow "beforeChange" event handlers to influence a change
    function filterChange(doc, change, update) {
      var obj = {
        canceled: false,
        from: change.from,
        to: change.to,
        text: change.text,
        origin: change.origin,
        cancel: function() { this.canceled = true; }
      };
      if (update) obj.update = function(from, to, text, origin) {
        if (from) this.from = clipPos(doc, from);
        if (to) this.to = clipPos(doc, to);
        if (text) this.text = text;
        if (origin !== undefined) this.origin = origin;
      };
      signal(doc, "beforeChange", doc, obj);
      if (doc.cm) signal(doc.cm, "beforeChange", doc.cm, obj);
  
      if (obj.canceled) return null;
      return {from: obj.from, to: obj.to, text: obj.text, origin: obj.origin};
    }
  
    // Apply a change to a document, and add it to the document's
    // history, and propagating it to all linked documents.
    function makeChange(doc, change, ignoreReadOnly) {
      if (doc.cm) {
        if (!doc.cm.curOp) return operation(doc.cm, makeChange)(doc, change, ignoreReadOnly);
        if (doc.cm.state.suppressEdits) return;
      }
  
      if (hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange")) {
        change = filterChange(doc, change, true);
        if (!change) return;
      }
  
      // Possibly split or suppress the update based on the presence
      // of read-only spans in its range.
      var split = sawReadOnlySpans && !ignoreReadOnly && removeReadOnlyRanges(doc, change.from, change.to);
      if (split) {
        for (var i = split.length - 1; i >= 0; --i)
          makeChangeInner(doc, {from: split[i].from, to: split[i].to, text: i ? [""] : change.text});
      } else {
        makeChangeInner(doc, change);
      }
    }
  
    function makeChangeInner(doc, change) {
      if (change.text.length == 1 && change.text[0] == "" && cmp(change.from, change.to) == 0) return;
      var selAfter = computeSelAfterChange(doc, change);
      addChangeToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);
  
      makeChangeSingleDoc(doc, change, selAfter, stretchSpansOverChange(doc, change));
      var rebased = [];
  
      linkedDocs(doc, function(doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, stretchSpansOverChange(doc, change));
      });
    }
  
    // Revert a change stored in a document's history.
    function makeChangeFromHistory(doc, type, allowSelectionOnly) {
      if (doc.cm && doc.cm.state.suppressEdits) return;
  
      var hist = doc.history, event, selAfter = doc.sel;
      var source = type == "undo" ? hist.done : hist.undone, dest = type == "undo" ? hist.undone : hist.done;
  
      // Verify that there is a useable event (so that ctrl-z won't
      // needlessly clear selection events)
      for (var i = 0; i < source.length; i++) {
        event = source[i];
        if (allowSelectionOnly ? event.ranges && !event.equals(doc.sel) : !event.ranges)
          break;
      }
      if (i == source.length) return;
      hist.lastOrigin = hist.lastSelOrigin = null;
  
      for (;;) {
        event = source.pop();
        if (event.ranges) {
          pushSelectionToHistory(event, dest);
          if (allowSelectionOnly && !event.equals(doc.sel)) {
            setSelection(doc, event, {clearRedo: false});
            return;
          }
          selAfter = event;
        }
        else break;
      }
  
      // Build up a reverse change object to add to the opposite history
      // stack (redo when undoing, and vice versa).
      var antiChanges = [];
      pushSelectionToHistory(selAfter, dest);
      dest.push({changes: antiChanges, generation: hist.generation});
      hist.generation = event.generation || ++hist.maxGeneration;
  
      var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");
  
      for (var i = event.changes.length - 1; i >= 0; --i) {
        var change = event.changes[i];
        change.origin = type;
        if (filter && !filterChange(doc, change, false)) {
          source.length = 0;
          return;
        }
  
        antiChanges.push(historyChangeFromChange(doc, change));
  
        var after = i ? computeSelAfterChange(doc, change) : lst(source);
        makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
        if (!i && doc.cm) doc.cm.scrollIntoView({from: change.from, to: changeEnd(change)});
        var rebased = [];
  
        // Propagate to the linked documents
        linkedDocs(doc, function(doc, sharedHist) {
          if (!sharedHist && indexOf(rebased, doc.history) == -1) {
            rebaseHist(doc.history, change);
            rebased.push(doc.history);
          }
          makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
        });
      }
    }
  
    // Sub-views need their line numbers shifted when text is added
    // above or below them in the parent document.
    function shiftDoc(doc, distance) {
      if (distance == 0) return;
      doc.first += distance;
      doc.sel = new Selection(map(doc.sel.ranges, function(range) {
        return new Range(Pos(range.anchor.line + distance, range.anchor.ch),
                         Pos(range.head.line + distance, range.head.ch));
      }), doc.sel.primIndex);
      if (doc.cm) {
        regChange(doc.cm, doc.first, doc.first - distance, distance);
        for (var d = doc.cm.display, l = d.viewFrom; l < d.viewTo; l++)
          regLineChange(doc.cm, l, "gutter");
      }
    }
  
    // More lower-level change function, handling only a single document
    // (not linked ones).
    function makeChangeSingleDoc(doc, change, selAfter, spans) {
      if (doc.cm && !doc.cm.curOp)
        return operation(doc.cm, makeChangeSingleDoc)(doc, change, selAfter, spans);
  
      if (change.to.line < doc.first) {
        shiftDoc(doc, change.text.length - 1 - (change.to.line - change.from.line));
        return;
      }
      if (change.from.line > doc.lastLine()) return;
  
      // Clip the change to the size of this doc
      if (change.from.line < doc.first) {
        var shift = change.text.length - 1 - (doc.first - change.from.line);
        shiftDoc(doc, shift);
        change = {from: Pos(doc.first, 0), to: Pos(change.to.line + shift, change.to.ch),
                  text: [lst(change.text)], origin: change.origin};
      }
      var last = doc.lastLine();
      if (change.to.line > last) {
        change = {from: change.from, to: Pos(last, getLine(doc, last).text.length),
                  text: [change.text[0]], origin: change.origin};
      }
  
      change.removed = getBetween(doc, change.from, change.to);
  
      if (!selAfter) selAfter = computeSelAfterChange(doc, change);
      if (doc.cm) makeChangeSingleDocInEditor(doc.cm, change, spans);
      else updateDoc(doc, change, spans);
      setSelectionNoUndo(doc, selAfter, sel_dontScroll);
    }
  
    // Handle the interaction of a change to a document with the editor
    // that this document is part of.
    function makeChangeSingleDocInEditor(cm, change, spans) {
      var doc = cm.doc, display = cm.display, from = change.from, to = change.to;
  
      var recomputeMaxLength = false, checkWidthStart = from.line;
      if (!cm.options.lineWrapping) {
        checkWidthStart = lineNo(visualLine(getLine(doc, from.line)));
        doc.iter(checkWidthStart, to.line + 1, function(line) {
          if (line == display.maxLine) {
            recomputeMaxLength = true;
            return true;
          }
        });
      }
  
      if (doc.sel.contains(change.from, change.to) > -1)
        signalCursorActivity(cm);
  
      updateDoc(doc, change, spans, estimateHeight(cm));
  
      if (!cm.options.lineWrapping) {
        doc.iter(checkWidthStart, from.line + change.text.length, function(line) {
          var len = lineLength(line);
          if (len > display.maxLineLength) {
            display.maxLine = line;
            display.maxLineLength = len;
            display.maxLineChanged = true;
            recomputeMaxLength = false;
          }
        });
        if (recomputeMaxLength) cm.curOp.updateMaxLine = true;
      }
  
      // Adjust frontier, schedule worker
      doc.frontier = Math.min(doc.frontier, from.line);
      startWorker(cm, 400);
  
      var lendiff = change.text.length - (to.line - from.line) - 1;
      // Remember that these lines changed, for updating the display
      if (change.full)
        regChange(cm);
      else if (from.line == to.line && change.text.length == 1 && !isWholeLineUpdate(cm.doc, change))
        regLineChange(cm, from.line, "text");
      else
        regChange(cm, from.line, to.line + 1, lendiff);
  
      var changesHandler = hasHandler(cm, "changes"), changeHandler = hasHandler(cm, "change");
      if (changeHandler || changesHandler) {
        var obj = {
          from: from, to: to,
          text: change.text,
          removed: change.removed,
          origin: change.origin
        };
        if (changeHandler) signalLater(cm, "change", cm, obj);
        if (changesHandler) (cm.curOp.changeObjs || (cm.curOp.changeObjs = [])).push(obj);
      }
      cm.display.selForContextMenu = null;
    }
  
    function replaceRange(doc, code, from, to, origin) {
      if (!to) to = from;
      if (cmp(to, from) < 0) { var tmp = to; to = from; from = tmp; }
      if (typeof code == "string") code = doc.splitLines(code);
      makeChange(doc, {from: from, to: to, text: code, origin: origin});
    }
  
    // SCROLLING THINGS INTO VIEW
  
    // If an editor sits on the top or bottom of the window, partially
    // scrolled out of view, this ensures that the cursor is visible.
    function maybeScrollWindow(cm, coords) {
      if (signalDOMEvent(cm, "scrollCursorIntoView")) return;
  
      var display = cm.display, box = display.sizer.getBoundingClientRect(), doScroll = null;
      if (coords.top + box.top < 0) doScroll = true;
      else if (coords.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) doScroll = false;
      if (doScroll != null && !phantom) {
        var scrollNode = elt("div", "\u200b", null, "position: absolute; top: " +
                             (coords.top - display.viewOffset - paddingTop(cm.display)) + "px; height: " +
                             (coords.bottom - coords.top + scrollGap(cm) + display.barHeight) + "px; left: " +
                             coords.left + "px; width: 2px;");
        cm.display.lineSpace.appendChild(scrollNode);
        scrollNode.scrollIntoView(doScroll);
        cm.display.lineSpace.removeChild(scrollNode);
      }
    }
  
    // Scroll a given position into view (immediately), verifying that
    // it actually became visible (as line heights are accurately
    // measured, the position of something may 'drift' during drawing).
    function scrollPosIntoView(cm, pos, end, margin) {
      if (margin == null) margin = 0;
      for (var limit = 0; limit < 5; limit++) {
        var changed = false, coords = cursorCoords(cm, pos);
        var endCoords = !end || end == pos ? coords : cursorCoords(cm, end);
        var scrollPos = calculateScrollPos(cm, Math.min(coords.left, endCoords.left),
                                           Math.min(coords.top, endCoords.top) - margin,
                                           Math.max(coords.left, endCoords.left),
                                           Math.max(coords.bottom, endCoords.bottom) + margin);
        var startTop = cm.doc.scrollTop, startLeft = cm.doc.scrollLeft;
        if (scrollPos.scrollTop != null) {
          setScrollTop(cm, scrollPos.scrollTop);
          if (Math.abs(cm.doc.scrollTop - startTop) > 1) changed = true;
        }
        if (scrollPos.scrollLeft != null) {
          setScrollLeft(cm, scrollPos.scrollLeft);
          if (Math.abs(cm.doc.scrollLeft - startLeft) > 1) changed = true;
        }
        if (!changed) break;
      }
      return coords;
    }
  
    // Scroll a given set of coordinates into view (immediately).
    function scrollIntoView(cm, x1, y1, x2, y2) {
      var scrollPos = calculateScrollPos(cm, x1, y1, x2, y2);
      if (scrollPos.scrollTop != null) setScrollTop(cm, scrollPos.scrollTop);
      if (scrollPos.scrollLeft != null) setScrollLeft(cm, scrollPos.scrollLeft);
    }
  
    // Calculate a new scroll position needed to scroll the given
    // rectangle into view. Returns an object with scrollTop and
    // scrollLeft properties. When these are undefined, the
    // vertical/horizontal position does not need to be adjusted.
    function calculateScrollPos(cm, x1, y1, x2, y2) {
      var display = cm.display, snapMargin = textHeight(cm.display);
      if (y1 < 0) y1 = 0;
      var screentop = cm.curOp && cm.curOp.scrollTop != null ? cm.curOp.scrollTop : display.scroller.scrollTop;
      var screen = displayHeight(cm), result = {};
      if (y2 - y1 > screen) y2 = y1 + screen;
      var docBottom = cm.doc.height + paddingVert(display);
      var atTop = y1 < snapMargin, atBottom = y2 > docBottom - snapMargin;
      if (y1 < screentop) {
        result.scrollTop = atTop ? 0 : y1;
      } else if (y2 > screentop + screen) {
        var newTop = Math.min(y1, (atBottom ? docBottom : y2) - screen);
        if (newTop != screentop) result.scrollTop = newTop;
      }
  
      var screenleft = cm.curOp && cm.curOp.scrollLeft != null ? cm.curOp.scrollLeft : display.scroller.scrollLeft;
      var screenw = displayWidth(cm) - (cm.options.fixedGutter ? display.gutters.offsetWidth : 0);
      var tooWide = x2 - x1 > screenw;
      if (tooWide) x2 = x1 + screenw;
      if (x1 < 10)
        result.scrollLeft = 0;
      else if (x1 < screenleft)
        result.scrollLeft = Math.max(0, x1 - (tooWide ? 0 : 10));
      else if (x2 > screenw + screenleft - 3)
        result.scrollLeft = x2 + (tooWide ? 0 : 10) - screenw;
      return result;
    }
  
    // Store a relative adjustment to the scroll position in the current
    // operation (to be applied when the operation finishes).
    function addToScrollPos(cm, left, top) {
      if (left != null || top != null) resolveScrollToPos(cm);
      if (left != null)
        cm.curOp.scrollLeft = (cm.curOp.scrollLeft == null ? cm.doc.scrollLeft : cm.curOp.scrollLeft) + left;
      if (top != null)
        cm.curOp.scrollTop = (cm.curOp.scrollTop == null ? cm.doc.scrollTop : cm.curOp.scrollTop) + top;
    }
  
    // Make sure that at the end of the operation the current cursor is
    // shown.
    function ensureCursorVisible(cm) {
      resolveScrollToPos(cm);
      var cur = cm.getCursor(), from = cur, to = cur;
      if (!cm.options.lineWrapping) {
        from = cur.ch ? Pos(cur.line, cur.ch - 1) : cur;
        to = Pos(cur.line, cur.ch + 1);
      }
      cm.curOp.scrollToPos = {from: from, to: to, margin: cm.options.cursorScrollMargin, isCursor: true};
    }
  
    // When an operation has its scrollToPos property set, and another
    // scroll action is applied before the end of the operation, this
    // 'simulates' scrolling that position into view in a cheap way, so
    // that the effect of intermediate scroll commands is not ignored.
    function resolveScrollToPos(cm) {
      var range = cm.curOp.scrollToPos;
      if (range) {
        cm.curOp.scrollToPos = null;
        var from = estimateCoords(cm, range.from), to = estimateCoords(cm, range.to);
        var sPos = calculateScrollPos(cm, Math.min(from.left, to.left),
                                      Math.min(from.top, to.top) - range.margin,
                                      Math.max(from.right, to.right),
                                      Math.max(from.bottom, to.bottom) + range.margin);
        cm.scrollTo(sPos.scrollLeft, sPos.scrollTop);
      }
    }
  
    // API UTILITIES
  
    // Indent the given line. The how parameter can be "smart",
    // "add"/null, "subtract", or "prev". When aggressive is false
    // (typically set to true for forced single-line indents), empty
    // lines are not indented, and places where the mode returns Pass
    // are left alone.
    function indentLine(cm, n, how, aggressive) {
      var doc = cm.doc, state;
      if (how == null) how = "add";
      if (how == "smart") {
        // Fall back to "prev" when the mode doesn't have an indentation
        // method.
        if (!doc.mode.indent) how = "prev";
        else state = getStateBefore(cm, n);
      }
  
      var tabSize = cm.options.tabSize;
      var line = getLine(doc, n), curSpace = countColumn(line.text, null, tabSize);
      if (line.stateAfter) line.stateAfter = null;
      var curSpaceString = line.text.match(/^\s*/)[0], indentation;
      if (!aggressive && !/\S/.test(line.text)) {
        indentation = 0;
        how = "not";
      } else if (how == "smart") {
        indentation = doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
        if (indentation == Pass || indentation > 150) {
          if (!aggressive) return;
          how = "prev";
        }
      }
      if (how == "prev") {
        if (n > doc.first) indentation = countColumn(getLine(doc, n-1).text, null, tabSize);
        else indentation = 0;
      } else if (how == "add") {
        indentation = curSpace + cm.options.indentUnit;
      } else if (how == "subtract") {
        indentation = curSpace - cm.options.indentUnit;
      } else if (typeof how == "number") {
        indentation = curSpace + how;
      }
      indentation = Math.max(0, indentation);
  
      var indentString = "", pos = 0;
      if (cm.options.indentWithTabs)
        for (var i = Math.floor(indentation / tabSize); i; --i) {pos += tabSize; indentString += "\t";}
      if (pos < indentation) indentString += spaceStr(indentation - pos);
  
      if (indentString != curSpaceString) {
        replaceRange(doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
        line.stateAfter = null;
        return true;
      } else {
        // Ensure that, if the cursor was in the whitespace at the start
        // of the line, it is moved to the end of that space.
        for (var i = 0; i < doc.sel.ranges.length; i++) {
          var range = doc.sel.ranges[i];
          if (range.head.line == n && range.head.ch < curSpaceString.length) {
            var pos = Pos(n, curSpaceString.length);
            replaceOneSelection(doc, i, new Range(pos, pos));
            break;
          }
        }
      }
    }
  
    // Utility for applying a change to a line by handle or number,
    // returning the number and optionally registering the line as
    // changed.
    function changeLine(doc, handle, changeType, op) {
      var no = handle, line = handle;
      if (typeof handle == "number") line = getLine(doc, clipLine(doc, handle));
      else no = lineNo(handle);
      if (no == null) return null;
      if (op(line, no) && doc.cm) regLineChange(doc.cm, no, changeType);
      return line;
    }
  
    // Helper for deleting text near the selection(s), used to implement
    // backspace, delete, and similar functionality.
    function deleteNearSelection(cm, compute) {
      var ranges = cm.doc.sel.ranges, kill = [];
      // Build up a set of ranges to kill first, merging overlapping
      // ranges.
      for (var i = 0; i < ranges.length; i++) {
        var toKill = compute(ranges[i]);
        while (kill.length && cmp(toKill.from, lst(kill).to) <= 0) {
          var replaced = kill.pop();
          if (cmp(replaced.from, toKill.from) < 0) {
            toKill.from = replaced.from;
            break;
          }
        }
        kill.push(toKill);
      }
      // Next, remove those actual ranges.
      runInOp(cm, function() {
        for (var i = kill.length - 1; i >= 0; i--)
          replaceRange(cm.doc, "", kill[i].from, kill[i].to, "+delete");
        ensureCursorVisible(cm);
      });
    }
  
    // Used for horizontal relative motion. Dir is -1 or 1 (left or
    // right), unit can be "char", "column" (like char, but doesn't
    // cross line boundaries), "word" (across next word), or "group" (to
    // the start of next group of word or non-word-non-whitespace
    // chars). The visually param controls whether, in right-to-left
    // text, direction 1 means to move towards the next index in the
    // string, or towards the character to the right of the current
    // position. The resulting position will have a hitSide=true
    // property if it reached the end of the document.
    function findPosH(doc, pos, dir, unit, visually) {
      var line = pos.line, ch = pos.ch, origDir = dir;
      var lineObj = getLine(doc, line);
      var possible = true;
      function findNextLine() {
        var l = line + dir;
        if (l < doc.first || l >= doc.first + doc.size) return (possible = false);
        line = l;
        return lineObj = getLine(doc, l);
      }
      function moveOnce(boundToLine) {
        var next = (visually ? moveVisually : moveLogically)(lineObj, ch, dir, true);
        if (next == null) {
          if (!boundToLine && findNextLine()) {
            if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj);
            else ch = dir < 0 ? lineObj.text.length : 0;
          } else return (possible = false);
        } else ch = next;
        return true;
      }
  
      if (unit == "char") moveOnce();
      else if (unit == "column") moveOnce(true);
      else if (unit == "word" || unit == "group") {
        var sawType = null, group = unit == "group";
        var helper = doc.cm && doc.cm.getHelper(pos, "wordChars");
        for (var first = true;; first = false) {
          if (dir < 0 && !moveOnce(!first)) break;
          var cur = lineObj.text.charAt(ch) || "\n";
          var type = isWordChar(cur, helper) ? "w"
            : group && cur == "\n" ? "n"
            : !group || /\s/.test(cur) ? null
            : "p";
          if (group && !first && !type) type = "s";
          if (sawType && sawType != type) {
            if (dir < 0) {dir = 1; moveOnce();}
            break;
          }
  
          if (type) sawType = type;
          if (dir > 0 && !moveOnce(!first)) break;
        }
      }
      var result = skipAtomic(doc, Pos(line, ch), origDir, true);
      if (!possible) result.hitSide = true;
      return result;
    }
  
    // For relative vertical movement. Dir may be -1 or 1. Unit can be
    // "page" or "line". The resulting position will have a hitSide=true
    // property if it reached the end of the document.
    function findPosV(cm, pos, dir, unit) {
      var doc = cm.doc, x = pos.left, y;
      if (unit == "page") {
        var pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight);
        y = pos.top + dir * (pageSize - (dir < 0 ? 1.5 : .5) * textHeight(cm.display));
      } else if (unit == "line") {
        y = dir > 0 ? pos.bottom + 3 : pos.top - 3;
      }
      for (;;) {
        var target = coordsChar(cm, x, y);
        if (!target.outside) break;
        if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break; }
        y += dir * 5;
      }
      return target;
    }
  
    // EDITOR METHODS
  
    // The publicly visible API. Note that methodOp(f) means
    // 'wrap f in an operation, performed on its `this` parameter'.
  
    // This is not the complete set of editor methods. Most of the
    // methods defined on the Doc type are also injected into
    // CodeMirror.prototype, for backwards compatibility and
    // convenience.
  
    CodeMirror.prototype = {
      constructor: CodeMirror,
      focus: function(){window.focus(); this.display.input.focus();},
  
      setOption: function(option, value) {
        var options = this.options, old = options[option];
        if (options[option] == value && option != "mode") return;
        options[option] = value;
        if (optionHandlers.hasOwnProperty(option))
          operation(this, optionHandlers[option])(this, value, old);
      },
  
      getOption: function(option) {return this.options[option];},
      getDoc: function() {return this.doc;},
  
      addKeyMap: function(map, bottom) {
        this.state.keyMaps[bottom ? "push" : "unshift"](getKeyMap(map));
      },
      removeKeyMap: function(map) {
        var maps = this.state.keyMaps;
        for (var i = 0; i < maps.length; ++i)
          if (maps[i] == map || maps[i].name == map) {
            maps.splice(i, 1);
            return true;
          }
      },
  
      addOverlay: methodOp(function(spec, options) {
        var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
        if (mode.startState) throw new Error("Overlays may not be stateful.");
        this.state.overlays.push({mode: mode, modeSpec: spec, opaque: options && options.opaque});
        this.state.modeGen++;
        regChange(this);
      }),
      removeOverlay: methodOp(function(spec) {
        var overlays = this.state.overlays;
        for (var i = 0; i < overlays.length; ++i) {
          var cur = overlays[i].modeSpec;
          if (cur == spec || typeof spec == "string" && cur.name == spec) {
            overlays.splice(i, 1);
            this.state.modeGen++;
            regChange(this);
            return;
          }
        }
      }),
  
      indentLine: methodOp(function(n, dir, aggressive) {
        if (typeof dir != "string" && typeof dir != "number") {
          if (dir == null) dir = this.options.smartIndent ? "smart" : "prev";
          else dir = dir ? "add" : "subtract";
        }
        if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive);
      }),
      indentSelection: methodOp(function(how) {
        var ranges = this.doc.sel.ranges, end = -1;
        for (var i = 0; i < ranges.length; i++) {
          var range = ranges[i];
          if (!range.empty()) {
            var from = range.from(), to = range.to();
            var start = Math.max(end, from.line);
            end = Math.min(this.lastLine(), to.line - (to.ch ? 0 : 1)) + 1;
            for (var j = start; j < end; ++j)
              indentLine(this, j, how);
            var newRanges = this.doc.sel.ranges;
            if (from.ch == 0 && ranges.length == newRanges.length && newRanges[i].from().ch > 0)
              replaceOneSelection(this.doc, i, new Range(from, newRanges[i].to()), sel_dontScroll);
          } else if (range.head.line > end) {
            indentLine(this, range.head.line, how, true);
            end = range.head.line;
            if (i == this.doc.sel.primIndex) ensureCursorVisible(this);
          }
        }
      }),
  
      // Fetch the parser token for a given character. Useful for hacks
      // that want to inspect the mode state (say, for completion).
      getTokenAt: function(pos, precise) {
        return takeToken(this, pos, precise);
      },
  
      getLineTokens: function(line, precise) {
        return takeToken(this, Pos(line), precise, true);
      },
  
      getTokenTypeAt: function(pos) {
        pos = clipPos(this.doc, pos);
        var styles = getLineStyles(this, getLine(this.doc, pos.line));
        var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
        var type;
        if (ch == 0) type = styles[2];
        else for (;;) {
          var mid = (before + after) >> 1;
          if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid;
          else if (styles[mid * 2 + 1] < ch) before = mid + 1;
          else { type = styles[mid * 2 + 2]; break; }
        }
        var cut = type ? type.indexOf("cm-overlay ") : -1;
        return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1);
      },
  
      getModeAt: function(pos) {
        var mode = this.doc.mode;
        if (!mode.innerMode) return mode;
        return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode;
      },
  
      getHelper: function(pos, type) {
        return this.getHelpers(pos, type)[0];
      },
  
      getHelpers: function(pos, type) {
        var found = [];
        if (!helpers.hasOwnProperty(type)) return found;
        var help = helpers[type], mode = this.getModeAt(pos);
        if (typeof mode[type] == "string") {
          if (help[mode[type]]) found.push(help[mode[type]]);
        } else if (mode[type]) {
          for (var i = 0; i < mode[type].length; i++) {
            var val = help[mode[type][i]];
            if (val) found.push(val);
          }
        } else if (mode.helperType && help[mode.helperType]) {
          found.push(help[mode.helperType]);
        } else if (help[mode.name]) {
          found.push(help[mode.name]);
        }
        for (var i = 0; i < help._global.length; i++) {
          var cur = help._global[i];
          if (cur.pred(mode, this) && indexOf(found, cur.val) == -1)
            found.push(cur.val);
        }
        return found;
      },
  
      getStateAfter: function(line, precise) {
        var doc = this.doc;
        line = clipLine(doc, line == null ? doc.first + doc.size - 1: line);
        return getStateBefore(this, line + 1, precise);
      },
  
      cursorCoords: function(start, mode) {
        var pos, range = this.doc.sel.primary();
        if (start == null) pos = range.head;
        else if (typeof start == "object") pos = clipPos(this.doc, start);
        else pos = start ? range.from() : range.to();
        return cursorCoords(this, pos, mode || "page");
      },
  
      charCoords: function(pos, mode) {
        return charCoords(this, clipPos(this.doc, pos), mode || "page");
      },
  
      coordsChar: function(coords, mode) {
        coords = fromCoordSystem(this, coords, mode || "page");
        return coordsChar(this, coords.left, coords.top);
      },
  
      lineAtHeight: function(height, mode) {
        height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top;
        return lineAtHeight(this.doc, height + this.display.viewOffset);
      },
      heightAtLine: function(line, mode) {
        var end = false, lineObj;
        if (typeof line == "number") {
          var last = this.doc.first + this.doc.size - 1;
          if (line < this.doc.first) line = this.doc.first;
          else if (line > last) { line = last; end = true; }
          lineObj = getLine(this.doc, line);
        } else {
          lineObj = line;
        }
        return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page").top +
          (end ? this.doc.height - heightAtLine(lineObj) : 0);
      },
  
      defaultTextHeight: function() { return textHeight(this.display); },
      defaultCharWidth: function() { return charWidth(this.display); },
  
      setGutterMarker: methodOp(function(line, gutterID, value) {
        return changeLine(this.doc, line, "gutter", function(line) {
          var markers = line.gutterMarkers || (line.gutterMarkers = {});
          markers[gutterID] = value;
          if (!value && isEmpty(markers)) line.gutterMarkers = null;
          return true;
        });
      }),
  
      clearGutter: methodOp(function(gutterID) {
        var cm = this, doc = cm.doc, i = doc.first;
        doc.iter(function(line) {
          if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
            line.gutterMarkers[gutterID] = null;
            regLineChange(cm, i, "gutter");
            if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null;
          }
          ++i;
        });
      }),
  
      lineInfo: function(line) {
        if (typeof line == "number") {
          if (!isLine(this.doc, line)) return null;
          var n = line;
          line = getLine(this.doc, line);
          if (!line) return null;
        } else {
          var n = lineNo(line);
          if (n == null) return null;
        }
        return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
                textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
                widgets: line.widgets};
      },
  
      getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo};},
  
      addWidget: function(pos, node, scroll, vert, horiz) {
        var display = this.display;
        pos = cursorCoords(this, clipPos(this.doc, pos));
        var top = pos.bottom, left = pos.left;
        node.style.position = "absolute";
        node.setAttribute("cm-ignore-events", "true");
        this.display.input.setUneditable(node);
        display.sizer.appendChild(node);
        if (vert == "over") {
          top = pos.top;
        } else if (vert == "above" || vert == "near") {
          var vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
          hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth);
          // Default to positioning above (if specified and possible); otherwise default to positioning below
          if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
            top = pos.top - node.offsetHeight;
          else if (pos.bottom + node.offsetHeight <= vspace)
            top = pos.bottom;
          if (left + node.offsetWidth > hspace)
            left = hspace - node.offsetWidth;
        }
        node.style.top = top + "px";
        node.style.left = node.style.right = "";
        if (horiz == "right") {
          left = display.sizer.clientWidth - node.offsetWidth;
          node.style.right = "0px";
        } else {
          if (horiz == "left") left = 0;
          else if (horiz == "middle") left = (display.sizer.clientWidth - node.offsetWidth) / 2;
          node.style.left = left + "px";
        }
        if (scroll)
          scrollIntoView(this, left, top, left + node.offsetWidth, top + node.offsetHeight);
      },
  
      triggerOnKeyDown: methodOp(onKeyDown),
      triggerOnKeyPress: methodOp(onKeyPress),
      triggerOnKeyUp: onKeyUp,
  
      execCommand: function(cmd) {
        if (commands.hasOwnProperty(cmd))
          return commands[cmd](this);
      },
  
      triggerElectric: methodOp(function(text) { triggerElectric(this, text); }),
  
      findPosH: function(from, amount, unit, visually) {
        var dir = 1;
        if (amount < 0) { dir = -1; amount = -amount; }
        for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
          cur = findPosH(this.doc, cur, dir, unit, visually);
          if (cur.hitSide) break;
        }
        return cur;
      },
  
      moveH: methodOp(function(dir, unit) {
        var cm = this;
        cm.extendSelectionsBy(function(range) {
          if (cm.display.shift || cm.doc.extend || range.empty())
            return findPosH(cm.doc, range.head, dir, unit, cm.options.rtlMoveVisually);
          else
            return dir < 0 ? range.from() : range.to();
        }, sel_move);
      }),
  
      deleteH: methodOp(function(dir, unit) {
        var sel = this.doc.sel, doc = this.doc;
        if (sel.somethingSelected())
          doc.replaceSelection("", null, "+delete");
        else
          deleteNearSelection(this, function(range) {
            var other = findPosH(doc, range.head, dir, unit, false);
            return dir < 0 ? {from: other, to: range.head} : {from: range.head, to: other};
          });
      }),
  
      findPosV: function(from, amount, unit, goalColumn) {
        var dir = 1, x = goalColumn;
        if (amount < 0) { dir = -1; amount = -amount; }
        for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
          var coords = cursorCoords(this, cur, "div");
          if (x == null) x = coords.left;
          else coords.left = x;
          cur = findPosV(this, coords, dir, unit);
          if (cur.hitSide) break;
        }
        return cur;
      },
  
      moveV: methodOp(function(dir, unit) {
        var cm = this, doc = this.doc, goals = [];
        var collapse = !cm.display.shift && !doc.extend && doc.sel.somethingSelected();
        doc.extendSelectionsBy(function(range) {
          if (collapse)
            return dir < 0 ? range.from() : range.to();
          var headPos = cursorCoords(cm, range.head, "div");
          if (range.goalColumn != null) headPos.left = range.goalColumn;
          goals.push(headPos.left);
          var pos = findPosV(cm, headPos, dir, unit);
          if (unit == "page" && range == doc.sel.primary())
            addToScrollPos(cm, null, charCoords(cm, pos, "div").top - headPos.top);
          return pos;
        }, sel_move);
        if (goals.length) for (var i = 0; i < doc.sel.ranges.length; i++)
          doc.sel.ranges[i].goalColumn = goals[i];
      }),
  
      // Find the word at the given position (as returned by coordsChar).
      findWordAt: function(pos) {
        var doc = this.doc, line = getLine(doc, pos.line).text;
        var start = pos.ch, end = pos.ch;
        if (line) {
          var helper = this.getHelper(pos, "wordChars");
          if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end;
          var startChar = line.charAt(start);
          var check = isWordChar(startChar, helper)
            ? function(ch) { return isWordChar(ch, helper); }
            : /\s/.test(startChar) ? function(ch) {return /\s/.test(ch);}
            : function(ch) {return !/\s/.test(ch) && !isWordChar(ch);};
          while (start > 0 && check(line.charAt(start - 1))) --start;
          while (end < line.length && check(line.charAt(end))) ++end;
        }
        return new Range(Pos(pos.line, start), Pos(pos.line, end));
      },
  
      toggleOverwrite: function(value) {
        if (value != null && value == this.state.overwrite) return;
        if (this.state.overwrite = !this.state.overwrite)
          addClass(this.display.cursorDiv, "CodeMirror-overwrite");
        else
          rmClass(this.display.cursorDiv, "CodeMirror-overwrite");
  
        signal(this, "overwriteToggle", this, this.state.overwrite);
      },
      hasFocus: function() { return this.display.input.getField() == activeElt(); },
  
      scrollTo: methodOp(function(x, y) {
        if (x != null || y != null) resolveScrollToPos(this);
        if (x != null) this.curOp.scrollLeft = x;
        if (y != null) this.curOp.scrollTop = y;
      }),
      getScrollInfo: function() {
        var scroller = this.display.scroller;
        return {left: scroller.scrollLeft, top: scroller.scrollTop,
                height: scroller.scrollHeight - scrollGap(this) - this.display.barHeight,
                width: scroller.scrollWidth - scrollGap(this) - this.display.barWidth,
                clientHeight: displayHeight(this), clientWidth: displayWidth(this)};
      },
  
      scrollIntoView: methodOp(function(range, margin) {
        if (range == null) {
          range = {from: this.doc.sel.primary().head, to: null};
          if (margin == null) margin = this.options.cursorScrollMargin;
        } else if (typeof range == "number") {
          range = {from: Pos(range, 0), to: null};
        } else if (range.from == null) {
          range = {from: range, to: null};
        }
        if (!range.to) range.to = range.from;
        range.margin = margin || 0;
  
        if (range.from.line != null) {
          resolveScrollToPos(this);
          this.curOp.scrollToPos = range;
        } else {
          var sPos = calculateScrollPos(this, Math.min(range.from.left, range.to.left),
                                        Math.min(range.from.top, range.to.top) - range.margin,
                                        Math.max(range.from.right, range.to.right),
                                        Math.max(range.from.bottom, range.to.bottom) + range.margin);
          this.scrollTo(sPos.scrollLeft, sPos.scrollTop);
        }
      }),
  
      setSize: methodOp(function(width, height) {
        var cm = this;
        function interpret(val) {
          return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val;
        }
        if (width != null) cm.display.wrapper.style.width = interpret(width);
        if (height != null) cm.display.wrapper.style.height = interpret(height);
        if (cm.options.lineWrapping) clearLineMeasurementCache(this);
        var lineNo = cm.display.viewFrom;
        cm.doc.iter(lineNo, cm.display.viewTo, function(line) {
          if (line.widgets) for (var i = 0; i < line.widgets.length; i++)
            if (line.widgets[i].noHScroll) { regLineChange(cm, lineNo, "widget"); break; }
          ++lineNo;
        });
        cm.curOp.forceUpdate = true;
        signal(cm, "refresh", this);
      }),
  
      operation: function(f){return runInOp(this, f);},
  
      refresh: methodOp(function() {
        var oldHeight = this.display.cachedTextHeight;
        regChange(this);
        this.curOp.forceUpdate = true;
        clearCaches(this);
        this.scrollTo(this.doc.scrollLeft, this.doc.scrollTop);
        updateGutterSpace(this);
        if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
          estimateLineHeights(this);
        signal(this, "refresh", this);
      }),
  
      swapDoc: methodOp(function(doc) {
        var old = this.doc;
        old.cm = null;
        attachDoc(this, doc);
        clearCaches(this);
        this.display.input.reset();
        this.scrollTo(doc.scrollLeft, doc.scrollTop);
        this.curOp.forceScroll = true;
        signalLater(this, "swapDoc", this, old);
        return old;
      }),
  
      getInputField: function(){return this.display.input.getField();},
      getWrapperElement: function(){return this.display.wrapper;},
      getScrollerElement: function(){return this.display.scroller;},
      getGutterElement: function(){return this.display.gutters;}
    };
    eventMixin(CodeMirror);
  
    // OPTION DEFAULTS
  
    // The default configuration options.
    var defaults = CodeMirror.defaults = {};
    // Functions to run when options are changed.
    var optionHandlers = CodeMirror.optionHandlers = {};
  
    function option(name, deflt, handle, notOnInit) {
      CodeMirror.defaults[name] = deflt;
      if (handle) optionHandlers[name] =
        notOnInit ? function(cm, val, old) {if (old != Init) handle(cm, val, old);} : handle;
    }
  
    // Passed to option handlers when there is no old value.
    var Init = CodeMirror.Init = {toString: function(){return "CodeMirror.Init";}};
  
    // These two are, on init, called from the constructor because they
    // have to be initialized before the editor can start at all.
    option("value", "", function(cm, val) {
      cm.setValue(val);
    }, true);
    option("mode", null, function(cm, val) {
      cm.doc.modeOption = val;
      loadMode(cm);
    }, true);
  
    option("indentUnit", 2, loadMode, true);
    option("indentWithTabs", false);
    option("smartIndent", true);
    option("tabSize", 4, function(cm) {
      resetModeState(cm);
      clearCaches(cm);
      regChange(cm);
    }, true);
    option("lineSeparator", null, function(cm, val) {
      cm.doc.lineSep = val;
      if (!val) return;
      var newBreaks = [], lineNo = cm.doc.first;
      cm.doc.iter(function(line) {
        for (var pos = 0;;) {
          var found = line.text.indexOf(val, pos);
          if (found == -1) break;
          pos = found + val.length;
          newBreaks.push(Pos(lineNo, found));
        }
        lineNo++;
      });
      for (var i = newBreaks.length - 1; i >= 0; i--)
        replaceRange(cm.doc, val, newBreaks[i], Pos(newBreaks[i].line, newBreaks[i].ch + val.length))
    });
    option("specialChars", /[\t\u0000-\u0019\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, function(cm, val, old) {
      cm.state.specialChars = new RegExp(val.source + (val.test("\t") ? "" : "|\t"), "g");
      if (old != CodeMirror.Init) cm.refresh();
    });
    option("specialCharPlaceholder", defaultSpecialCharPlaceholder, function(cm) {cm.refresh();}, true);
    option("electricChars", true);
    option("inputStyle", mobile ? "contenteditable" : "textarea", function() {
      throw new Error("inputStyle can not (yet) be changed in a running editor"); // FIXME
    }, true);
    option("rtlMoveVisually", !windows);
    option("wholeLineUpdateBefore", true);
  
    option("theme", "default", function(cm) {
      themeChanged(cm);
      guttersChanged(cm);
    }, true);
    option("keyMap", "default", function(cm, val, old) {
      var next = getKeyMap(val);
      var prev = old != CodeMirror.Init && getKeyMap(old);
      if (prev && prev.detach) prev.detach(cm, next);
      if (next.attach) next.attach(cm, prev || null);
    });
    option("extraKeys", null);
  
    option("lineWrapping", false, wrappingChanged, true);
    option("gutters", [], function(cm) {
      setGuttersForLineNumbers(cm.options);
      guttersChanged(cm);
    }, true);
    option("fixedGutter", true, function(cm, val) {
      cm.display.gutters.style.left = val ? compensateForHScroll(cm.display) + "px" : "0";
      cm.refresh();
    }, true);
    option("coverGutterNextToScrollbar", false, function(cm) {updateScrollbars(cm);}, true);
    option("scrollbarStyle", "native", function(cm) {
      initScrollbars(cm);
      updateScrollbars(cm);
      cm.display.scrollbars.setScrollTop(cm.doc.scrollTop);
      cm.display.scrollbars.setScrollLeft(cm.doc.scrollLeft);
    }, true);
    option("lineNumbers", false, function(cm) {
      setGuttersForLineNumbers(cm.options);
      guttersChanged(cm);
    }, true);
    option("firstLineNumber", 1, guttersChanged, true);
    option("lineNumberFormatter", function(integer) {return integer;}, guttersChanged, true);
    option("showCursorWhenSelecting", false, updateSelection, true);
  
    option("resetSelectionOnContextMenu", true);
    option("lineWiseCopyCut", true);
  
    option("readOnly", false, function(cm, val) {
      if (val == "nocursor") {
        onBlur(cm);
        cm.display.input.blur();
        cm.display.disabled = true;
      } else {
        cm.display.disabled = false;
        if (!val) cm.display.input.reset();
      }
    });
    option("disableInput", false, function(cm, val) {if (!val) cm.display.input.reset();}, true);
    option("dragDrop", true, dragDropChanged);
  
    option("cursorBlinkRate", 530);
    option("cursorScrollMargin", 0);
    option("cursorHeight", 1, updateSelection, true);
    option("singleCursorHeightPerLine", true, updateSelection, true);
    option("workTime", 100);
    option("workDelay", 100);
    option("flattenSpans", true, resetModeState, true);
    option("addModeClass", false, resetModeState, true);
    option("pollInterval", 100);
    option("undoDepth", 200, function(cm, val){cm.doc.history.undoDepth = val;});
    option("historyEventDelay", 1250);
    option("viewportMargin", 10, function(cm){cm.refresh();}, true);
    option("maxHighlightLength", 10000, resetModeState, true);
    option("moveInputWithCursor", true, function(cm, val) {
      if (!val) cm.display.input.resetPosition();
    });
  
    option("tabindex", null, function(cm, val) {
      cm.display.input.getField().tabIndex = val || "";
    });
    option("autofocus", null);
  
    // MODE DEFINITION AND QUERYING
  
    // Known modes, by name and by MIME
    var modes = CodeMirror.modes = {}, mimeModes = CodeMirror.mimeModes = {};
  
    // Extra arguments are stored as the mode's dependencies, which is
    // used by (legacy) mechanisms like loadmode.js to automatically
    // load a mode. (Preferred mechanism is the require/define calls.)
    CodeMirror.defineMode = function(name, mode) {
      if (!CodeMirror.defaults.mode && name != "null") CodeMirror.defaults.mode = name;
      if (arguments.length > 2)
        mode.dependencies = Array.prototype.slice.call(arguments, 2);
      modes[name] = mode;
    };
  
    CodeMirror.defineMIME = function(mime, spec) {
      mimeModes[mime] = spec;
    };
  
    // Given a MIME type, a {name, ...options} config object, or a name
    // string, return a mode config object.
    CodeMirror.resolveMode = function(spec) {
      if (typeof spec == "string" && mimeModes.hasOwnProperty(spec)) {
        spec = mimeModes[spec];
      } else if (spec && typeof spec.name == "string" && mimeModes.hasOwnProperty(spec.name)) {
        var found = mimeModes[spec.name];
        if (typeof found == "string") found = {name: found};
        spec = createObj(found, spec);
        spec.name = found.name;
      } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+xml$/.test(spec)) {
        return CodeMirror.resolveMode("application/xml");
      }
      if (typeof spec == "string") return {name: spec};
      else return spec || {name: "null"};
    };
  
    // Given a mode spec (anything that resolveMode accepts), find and
    // initialize an actual mode object.
    CodeMirror.getMode = function(options, spec) {
      var spec = CodeMirror.resolveMode(spec);
      var mfactory = modes[spec.name];
      if (!mfactory) return CodeMirror.getMode(options, "text/plain");
      var modeObj = mfactory(options, spec);
      if (modeExtensions.hasOwnProperty(spec.name)) {
        var exts = modeExtensions[spec.name];
        for (var prop in exts) {
          if (!exts.hasOwnProperty(prop)) continue;
          if (modeObj.hasOwnProperty(prop)) modeObj["_" + prop] = modeObj[prop];
          modeObj[prop] = exts[prop];
        }
      }
      modeObj.name = spec.name;
      if (spec.helperType) modeObj.helperType = spec.helperType;
      if (spec.modeProps) for (var prop in spec.modeProps)
        modeObj[prop] = spec.modeProps[prop];
  
      return modeObj;
    };
  
    // Minimal default mode.
    CodeMirror.defineMode("null", function() {
      return {token: function(stream) {stream.skipToEnd();}};
    });
    CodeMirror.defineMIME("text/plain", "null");
  
    // This can be used to attach properties to mode objects from
    // outside the actual mode definition.
    var modeExtensions = CodeMirror.modeExtensions = {};
    CodeMirror.extendMode = function(mode, properties) {
      var exts = modeExtensions.hasOwnProperty(mode) ? modeExtensions[mode] : (modeExtensions[mode] = {});
      copyObj(properties, exts);
    };
  
    // EXTENSIONS
  
    CodeMirror.defineExtension = function(name, func) {
      CodeMirror.prototype[name] = func;
    };
    CodeMirror.defineDocExtension = function(name, func) {
      Doc.prototype[name] = func;
    };
    CodeMirror.defineOption = option;
  
    var initHooks = [];
    CodeMirror.defineInitHook = function(f) {initHooks.push(f);};
  
    var helpers = CodeMirror.helpers = {};
    CodeMirror.registerHelper = function(type, name, value) {
      if (!helpers.hasOwnProperty(type)) helpers[type] = CodeMirror[type] = {_global: []};
      helpers[type][name] = value;
    };
    CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
      CodeMirror.registerHelper(type, name, value);
      helpers[type]._global.push({pred: predicate, val: value});
    };
  
    // MODE STATE HANDLING
  
    // Utility functions for working with state. Exported because nested
    // modes need to do this for their inner modes.
  
    var copyState = CodeMirror.copyState = function(mode, state) {
      if (state === true) return state;
      if (mode.copyState) return mode.copyState(state);
      var nstate = {};
      for (var n in state) {
        var val = state[n];
        if (val instanceof Array) val = val.concat([]);
        nstate[n] = val;
      }
      return nstate;
    };
  
    var startState = CodeMirror.startState = function(mode, a1, a2) {
      return mode.startState ? mode.startState(a1, a2) : true;
    };
  
    // Given a mode and a state (for that mode), find the inner mode and
    // state at the position that the state refers to.
    CodeMirror.innerMode = function(mode, state) {
      while (mode.innerMode) {
        var info = mode.innerMode(state);
        if (!info || info.mode == mode) break;
        state = info.state;
        mode = info.mode;
      }
      return info || {mode: mode, state: state};
    };
  
    // STANDARD COMMANDS
  
    // Commands are parameter-less actions that can be performed on an
    // editor, mostly used for keybindings.
    var commands = CodeMirror.commands = {
      selectAll: function(cm) {cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()), sel_dontScroll);},
      singleSelection: function(cm) {
        cm.setSelection(cm.getCursor("anchor"), cm.getCursor("head"), sel_dontScroll);
      },
      killLine: function(cm) {
        deleteNearSelection(cm, function(range) {
          if (range.empty()) {
            var len = getLine(cm.doc, range.head.line).text.length;
            if (range.head.ch == len && range.head.line < cm.lastLine())
              return {from: range.head, to: Pos(range.head.line + 1, 0)};
            else
              return {from: range.head, to: Pos(range.head.line, len)};
          } else {
            return {from: range.from(), to: range.to()};
          }
        });
      },
      deleteLine: function(cm) {
        deleteNearSelection(cm, function(range) {
          return {from: Pos(range.from().line, 0),
                  to: clipPos(cm.doc, Pos(range.to().line + 1, 0))};
        });
      },
      delLineLeft: function(cm) {
        deleteNearSelection(cm, function(range) {
          return {from: Pos(range.from().line, 0), to: range.from()};
        });
      },
      delWrappedLineLeft: function(cm) {
        deleteNearSelection(cm, function(range) {
          var top = cm.charCoords(range.head, "div").top + 5;
          var leftPos = cm.coordsChar({left: 0, top: top}, "div");
          return {from: leftPos, to: range.from()};
        });
      },
      delWrappedLineRight: function(cm) {
        deleteNearSelection(cm, function(range) {
          var top = cm.charCoords(range.head, "div").top + 5;
          var rightPos = cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
          return {from: range.from(), to: rightPos };
        });
      },
      undo: function(cm) {cm.undo();},
      redo: function(cm) {cm.redo();},
      undoSelection: function(cm) {cm.undoSelection();},
      redoSelection: function(cm) {cm.redoSelection();},
      goDocStart: function(cm) {cm.extendSelection(Pos(cm.firstLine(), 0));},
      goDocEnd: function(cm) {cm.extendSelection(Pos(cm.lastLine()));},
      goLineStart: function(cm) {
        cm.extendSelectionsBy(function(range) { return lineStart(cm, range.head.line); },
                              {origin: "+move", bias: 1});
      },
      goLineStartSmart: function(cm) {
        cm.extendSelectionsBy(function(range) {
          return lineStartSmart(cm, range.head);
        }, {origin: "+move", bias: 1});
      },
      goLineEnd: function(cm) {
        cm.extendSelectionsBy(function(range) { return lineEnd(cm, range.head.line); },
                              {origin: "+move", bias: -1});
      },
      goLineRight: function(cm) {
        cm.extendSelectionsBy(function(range) {
          var top = cm.charCoords(range.head, "div").top + 5;
          return cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
        }, sel_move);
      },
      goLineLeft: function(cm) {
        cm.extendSelectionsBy(function(range) {
          var top = cm.charCoords(range.head, "div").top + 5;
          return cm.coordsChar({left: 0, top: top}, "div");
        }, sel_move);
      },
      goLineLeftSmart: function(cm) {
        cm.extendSelectionsBy(function(range) {
          var top = cm.charCoords(range.head, "div").top + 5;
          var pos = cm.coordsChar({left: 0, top: top}, "div");
          if (pos.ch < cm.getLine(pos.line).search(/\S/)) return lineStartSmart(cm, range.head);
          return pos;
        }, sel_move);
      },
      goLineUp: function(cm) {cm.moveV(-1, "line");},
      goLineDown: function(cm) {cm.moveV(1, "line");},
      goPageUp: function(cm) {cm.moveV(-1, "page");},
      goPageDown: function(cm) {cm.moveV(1, "page");},
      goCharLeft: function(cm) {cm.moveH(-1, "char");},
      goCharRight: function(cm) {cm.moveH(1, "char");},
      goColumnLeft: function(cm) {cm.moveH(-1, "column");},
      goColumnRight: function(cm) {cm.moveH(1, "column");},
      goWordLeft: function(cm) {cm.moveH(-1, "word");},
      goGroupRight: function(cm) {cm.moveH(1, "group");},
      goGroupLeft: function(cm) {cm.moveH(-1, "group");},
      goWordRight: function(cm) {cm.moveH(1, "word");},
      delCharBefore: function(cm) {cm.deleteH(-1, "char");},
      delCharAfter: function(cm) {cm.deleteH(1, "char");},
      delWordBefore: function(cm) {cm.deleteH(-1, "word");},
      delWordAfter: function(cm) {cm.deleteH(1, "word");},
      delGroupBefore: function(cm) {cm.deleteH(-1, "group");},
      delGroupAfter: function(cm) {cm.deleteH(1, "group");},
      indentAuto: function(cm) {cm.indentSelection("smart");},
      indentMore: function(cm) {cm.indentSelection("add");},
      indentLess: function(cm) {cm.indentSelection("subtract");},
      insertTab: function(cm) {cm.replaceSelection("\t");},
      insertSoftTab: function(cm) {
        var spaces = [], ranges = cm.listSelections(), tabSize = cm.options.tabSize;
        for (var i = 0; i < ranges.length; i++) {
          var pos = ranges[i].from();
          var col = countColumn(cm.getLine(pos.line), pos.ch, tabSize);
          spaces.push(new Array(tabSize - col % tabSize + 1).join(" "));
        }
        cm.replaceSelections(spaces);
      },
      defaultTab: function(cm) {
        if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.execCommand("insertTab");
      },
      transposeChars: function(cm) {
        runInOp(cm, function() {
          var ranges = cm.listSelections(), newSel = [];
          for (var i = 0; i < ranges.length; i++) {
            var cur = ranges[i].head, line = getLine(cm.doc, cur.line).text;
            if (line) {
              if (cur.ch == line.length) cur = new Pos(cur.line, cur.ch - 1);
              if (cur.ch > 0) {
                cur = new Pos(cur.line, cur.ch + 1);
                cm.replaceRange(line.charAt(cur.ch - 1) + line.charAt(cur.ch - 2),
                                Pos(cur.line, cur.ch - 2), cur, "+transpose");
              } else if (cur.line > cm.doc.first) {
                var prev = getLine(cm.doc, cur.line - 1).text;
                if (prev)
                  cm.replaceRange(line.charAt(0) + cm.doc.lineSeparator() +
                                  prev.charAt(prev.length - 1),
                                  Pos(cur.line - 1, prev.length - 1), Pos(cur.line, 1), "+transpose");
              }
            }
            newSel.push(new Range(cur, cur));
          }
          cm.setSelections(newSel);
        });
      },
      newlineAndIndent: function(cm) {
        runInOp(cm, function() {
          var len = cm.listSelections().length;
          for (var i = 0; i < len; i++) {
            var range = cm.listSelections()[i];
            cm.replaceRange(cm.doc.lineSeparator(), range.anchor, range.head, "+input");
            cm.indentLine(range.from().line + 1, null, true);
            ensureCursorVisible(cm);
          }
        });
      },
      toggleOverwrite: function(cm) {cm.toggleOverwrite();}
    };
  
  
    // STANDARD KEYMAPS
  
    var keyMap = CodeMirror.keyMap = {};
  
    keyMap.basic = {
      "Left": "goCharLeft", "Right": "goCharRight", "Up": "goLineUp", "Down": "goLineDown",
      "End": "goLineEnd", "Home": "goLineStartSmart", "PageUp": "goPageUp", "PageDown": "goPageDown",
      "Delete": "delCharAfter", "Backspace": "delCharBefore", "Shift-Backspace": "delCharBefore",
      "Tab": "defaultTab", "Shift-Tab": "indentAuto",
      "Enter": "newlineAndIndent", "Insert": "toggleOverwrite",
      "Esc": "singleSelection"
    };
    // Note that the save and find-related commands aren't defined by
    // default. User code or addons can define them. Unknown commands
    // are simply ignored.
    keyMap.pcDefault = {
      "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
      "Ctrl-Home": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Up": "goLineUp", "Ctrl-Down": "goLineDown",
      "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
      "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
      "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
      "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
      "Ctrl-U": "undoSelection", "Shift-Ctrl-U": "redoSelection", "Alt-U": "redoSelection",
      fallthrough: "basic"
    };
    // Very basic readline/emacs-style bindings, which are standard on Mac.
    keyMap.emacsy = {
      "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
      "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
      "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
      "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars"
    };
    keyMap.macDefault = {
      "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
      "Cmd-Home": "goDocStart", "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
      "Alt-Right": "goGroupRight", "Cmd-Left": "goLineLeft", "Cmd-Right": "goLineRight", "Alt-Backspace": "delGroupBefore",
      "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
      "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
      "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delWrappedLineLeft", "Cmd-Delete": "delWrappedLineRight",
      "Cmd-U": "undoSelection", "Shift-Cmd-U": "redoSelection", "Ctrl-Up": "goDocStart", "Ctrl-Down": "goDocEnd",
      fallthrough: ["basic", "emacsy"]
    };
    keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;
  
    // KEYMAP DISPATCH
  
    function normalizeKeyName(name) {
      var parts = name.split(/-(?!$)/), name = parts[parts.length - 1];
      var alt, ctrl, shift, cmd;
      for (var i = 0; i < parts.length - 1; i++) {
        var mod = parts[i];
        if (/^(cmd|meta|m)$/i.test(mod)) cmd = true;
        else if (/^a(lt)?$/i.test(mod)) alt = true;
        else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
        else if (/^s(hift)$/i.test(mod)) shift = true;
        else throw new Error("Unrecognized modifier name: " + mod);
      }
      if (alt) name = "Alt-" + name;
      if (ctrl) name = "Ctrl-" + name;
      if (cmd) name = "Cmd-" + name;
      if (shift) name = "Shift-" + name;
      return name;
    }
  
    // This is a kludge to keep keymaps mostly working as raw objects
    // (backwards compatibility) while at the same time support features
    // like normalization and multi-stroke key bindings. It compiles a
    // new normalized keymap, and then updates the old object to reflect
    // this.
    CodeMirror.normalizeKeyMap = function(keymap) {
      var copy = {};
      for (var keyname in keymap) if (keymap.hasOwnProperty(keyname)) {
        var value = keymap[keyname];
        if (/^(name|fallthrough|(de|at)tach)$/.test(keyname)) continue;
        if (value == "...") { delete keymap[keyname]; continue; }
  
        var keys = map(keyname.split(" "), normalizeKeyName);
        for (var i = 0; i < keys.length; i++) {
          var val, name;
          if (i == keys.length - 1) {
            name = keys.join(" ");
            val = value;
          } else {
            name = keys.slice(0, i + 1).join(" ");
            val = "...";
          }
          var prev = copy[name];
          if (!prev) copy[name] = val;
          else if (prev != val) throw new Error("Inconsistent bindings for " + name);
        }
        delete keymap[keyname];
      }
      for (var prop in copy) keymap[prop] = copy[prop];
      return keymap;
    };
  
    var lookupKey = CodeMirror.lookupKey = function(key, map, handle, context) {
      map = getKeyMap(map);
      var found = map.call ? map.call(key, context) : map[key];
      if (found === false) return "nothing";
      if (found === "...") return "multi";
      if (found != null && handle(found)) return "handled";
  
      if (map.fallthrough) {
        if (Object.prototype.toString.call(map.fallthrough) != "[object Array]")
          return lookupKey(key, map.fallthrough, handle, context);
        for (var i = 0; i < map.fallthrough.length; i++) {
          var result = lookupKey(key, map.fallthrough[i], handle, context);
          if (result) return result;
        }
      }
    };
  
    // Modifier key presses don't count as 'real' key presses for the
    // purpose of keymap fallthrough.
    var isModifierKey = CodeMirror.isModifierKey = function(value) {
      var name = typeof value == "string" ? value : keyNames[value.keyCode];
      return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod";
    };
  
    // Look up the name of a key as indicated by an event object.
    var keyName = CodeMirror.keyName = function(event, noShift) {
      if (presto && event.keyCode == 34 && event["char"]) return false;
      var base = keyNames[event.keyCode], name = base;
      if (name == null || event.altGraphKey) return false;
      if (event.altKey && base != "Alt") name = "Alt-" + name;
      if ((flipCtrlCmd ? event.metaKey : event.ctrlKey) && base != "Ctrl") name = "Ctrl-" + name;
      if ((flipCtrlCmd ? event.ctrlKey : event.metaKey) && base != "Cmd") name = "Cmd-" + name;
      if (!noShift && event.shiftKey && base != "Shift") name = "Shift-" + name;
      return name;
    };
  
    function getKeyMap(val) {
      return typeof val == "string" ? keyMap[val] : val;
    }
  
    // FROMTEXTAREA
  
    CodeMirror.fromTextArea = function(textarea, options) {
      options = options ? copyObj(options) : {};
      options.value = textarea.value;
      if (!options.tabindex && textarea.tabIndex)
        options.tabindex = textarea.tabIndex;
      if (!options.placeholder && textarea.placeholder)
        options.placeholder = textarea.placeholder;
      // Set autofocus to true if this textarea is focused, or if it has
      // autofocus and no other element is focused.
      if (options.autofocus == null) {
        var hasFocus = activeElt();
        options.autofocus = hasFocus == textarea ||
          textarea.getAttribute("autofocus") != null && hasFocus == document.body;
      }
  
      function save() {textarea.value = cm.getValue();}
      if (textarea.form) {
        on(textarea.form, "submit", save);
        // Deplorable hack to make the submit method do the right thing.
        if (!options.leaveSubmitMethodAlone) {
          var form = textarea.form, realSubmit = form.submit;
          try {
            var wrappedSubmit = form.submit = function() {
              save();
              form.submit = realSubmit;
              form.submit();
              form.submit = wrappedSubmit;
            };
          } catch(e) {}
        }
      }
  
      options.finishInit = function(cm) {
        cm.save = save;
        cm.getTextArea = function() { return textarea; };
        cm.toTextArea = function() {
          cm.toTextArea = isNaN; // Prevent this from being ran twice
          save();
          textarea.parentNode.removeChild(cm.getWrapperElement());
          textarea.style.display = "";
          if (textarea.form) {
            off(textarea.form, "submit", save);
            if (typeof textarea.form.submit == "function")
              textarea.form.submit = realSubmit;
          }
        };
      };
  
      textarea.style.display = "none";
      var cm = CodeMirror(function(node) {
        textarea.parentNode.insertBefore(node, textarea.nextSibling);
      }, options);
      return cm;
    };
  
    // STRING STREAM
  
    // Fed to the mode parsers, provides helper functions to make
    // parsers more succinct.
  
    var StringStream = CodeMirror.StringStream = function(string, tabSize) {
      this.pos = this.start = 0;
      this.string = string;
      this.tabSize = tabSize || 8;
      this.lastColumnPos = this.lastColumnValue = 0;
      this.lineStart = 0;
    };
  
    StringStream.prototype = {
      eol: function() {return this.pos >= this.string.length;},
      sol: function() {return this.pos == this.lineStart;},
      peek: function() {return this.string.charAt(this.pos) || undefined;},
      next: function() {
        if (this.pos < this.string.length)
          return this.string.charAt(this.pos++);
      },
      eat: function(match) {
        var ch = this.string.charAt(this.pos);
        if (typeof match == "string") var ok = ch == match;
        else var ok = ch && (match.test ? match.test(ch) : match(ch));
        if (ok) {++this.pos; return ch;}
      },
      eatWhile: function(match) {
        var start = this.pos;
        while (this.eat(match)){}
        return this.pos > start;
      },
      eatSpace: function() {
        var start = this.pos;
        while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
        return this.pos > start;
      },
      skipToEnd: function() {this.pos = this.string.length;},
      skipTo: function(ch) {
        var found = this.string.indexOf(ch, this.pos);
        if (found > -1) {this.pos = found; return true;}
      },
      backUp: function(n) {this.pos -= n;},
      column: function() {
        if (this.lastColumnPos < this.start) {
          this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
          this.lastColumnPos = this.start;
        }
        return this.lastColumnValue - (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
      },
      indentation: function() {
        return countColumn(this.string, null, this.tabSize) -
          (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
      },
      match: function(pattern, consume, caseInsensitive) {
        if (typeof pattern == "string") {
          var cased = function(str) {return caseInsensitive ? str.toLowerCase() : str;};
          var substr = this.string.substr(this.pos, pattern.length);
          if (cased(substr) == cased(pattern)) {
            if (consume !== false) this.pos += pattern.length;
            return true;
          }
        } else {
          var match = this.string.slice(this.pos).match(pattern);
          if (match && match.index > 0) return null;
          if (match && consume !== false) this.pos += match[0].length;
          return match;
        }
      },
      current: function(){return this.string.slice(this.start, this.pos);},
      hideFirstChars: function(n, inner) {
        this.lineStart += n;
        try { return inner(); }
        finally { this.lineStart -= n; }
      }
    };
  
    // TEXTMARKERS
  
    // Created with markText and setBookmark methods. A TextMarker is a
    // handle that can be used to clear or find a marked position in the
    // document. Line objects hold arrays (markedSpans) containing
    // {from, to, marker} object pointing to such marker objects, and
    // indicating that such a marker is present on that line. Multiple
    // lines may point to the same marker when it spans across lines.
    // The spans will have null for their from/to properties when the
    // marker continues beyond the start/end of the line. Markers have
    // links back to the lines they currently touch.
  
    var nextMarkerId = 0;
  
    var TextMarker = CodeMirror.TextMarker = function(doc, type) {
      this.lines = [];
      this.type = type;
      this.doc = doc;
      this.id = ++nextMarkerId;
    };
    eventMixin(TextMarker);
  
    // Clear the marker.
    TextMarker.prototype.clear = function() {
      if (this.explicitlyCleared) return;
      var cm = this.doc.cm, withOp = cm && !cm.curOp;
      if (withOp) startOperation(cm);
      if (hasHandler(this, "clear")) {
        var found = this.find();
        if (found) signalLater(this, "clear", found.from, found.to);
      }
      var min = null, max = null;
      for (var i = 0; i < this.lines.length; ++i) {
        var line = this.lines[i];
        var span = getMarkedSpanFor(line.markedSpans, this);
        if (cm && !this.collapsed) regLineChange(cm, lineNo(line), "text");
        else if (cm) {
          if (span.to != null) max = lineNo(line);
          if (span.from != null) min = lineNo(line);
        }
        line.markedSpans = removeMarkedSpan(line.markedSpans, span);
        if (span.from == null && this.collapsed && !lineIsHidden(this.doc, line) && cm)
          updateLineHeight(line, textHeight(cm.display));
      }
      if (cm && this.collapsed && !cm.options.lineWrapping) for (var i = 0; i < this.lines.length; ++i) {
        var visual = visualLine(this.lines[i]), len = lineLength(visual);
        if (len > cm.display.maxLineLength) {
          cm.display.maxLine = visual;
          cm.display.maxLineLength = len;
          cm.display.maxLineChanged = true;
        }
      }
  
      if (min != null && cm && this.collapsed) regChange(cm, min, max + 1);
      this.lines.length = 0;
      this.explicitlyCleared = true;
      if (this.atomic && this.doc.cantEdit) {
        this.doc.cantEdit = false;
        if (cm) reCheckSelection(cm.doc);
      }
      if (cm) signalLater(cm, "markerCleared", cm, this);
      if (withOp) endOperation(cm);
      if (this.parent) this.parent.clear();
    };
  
    // Find the position of the marker in the document. Returns a {from,
    // to} object by default. Side can be passed to get a specific side
    // -- 0 (both), -1 (left), or 1 (right). When lineObj is true, the
    // Pos objects returned contain a line object, rather than a line
    // number (used to prevent looking up the same line twice).
    TextMarker.prototype.find = function(side, lineObj) {
      if (side == null && this.type == "bookmark") side = 1;
      var from, to;
      for (var i = 0; i < this.lines.length; ++i) {
        var line = this.lines[i];
        var span = getMarkedSpanFor(line.markedSpans, this);
        if (span.from != null) {
          from = Pos(lineObj ? line : lineNo(line), span.from);
          if (side == -1) return from;
        }
        if (span.to != null) {
          to = Pos(lineObj ? line : lineNo(line), span.to);
          if (side == 1) return to;
        }
      }
      return from && {from: from, to: to};
    };
  
    // Signals that the marker's widget changed, and surrounding layout
    // should be recomputed.
    TextMarker.prototype.changed = function() {
      var pos = this.find(-1, true), widget = this, cm = this.doc.cm;
      if (!pos || !cm) return;
      runInOp(cm, function() {
        var line = pos.line, lineN = lineNo(pos.line);
        var view = findViewForLine(cm, lineN);
        if (view) {
          clearLineMeasurementCacheFor(view);
          cm.curOp.selectionChanged = cm.curOp.forceUpdate = true;
        }
        cm.curOp.updateMaxLine = true;
        if (!lineIsHidden(widget.doc, line) && widget.height != null) {
          var oldHeight = widget.height;
          widget.height = null;
          var dHeight = widgetHeight(widget) - oldHeight;
          if (dHeight)
            updateLineHeight(line, line.height + dHeight);
        }
      });
    };
  
    TextMarker.prototype.attachLine = function(line) {
      if (!this.lines.length && this.doc.cm) {
        var op = this.doc.cm.curOp;
        if (!op.maybeHiddenMarkers || indexOf(op.maybeHiddenMarkers, this) == -1)
          (op.maybeUnhiddenMarkers || (op.maybeUnhiddenMarkers = [])).push(this);
      }
      this.lines.push(line);
    };
    TextMarker.prototype.detachLine = function(line) {
      this.lines.splice(indexOf(this.lines, line), 1);
      if (!this.lines.length && this.doc.cm) {
        var op = this.doc.cm.curOp;
        (op.maybeHiddenMarkers || (op.maybeHiddenMarkers = [])).push(this);
      }
    };
  
    // Collapsed markers have unique ids, in order to be able to order
    // them, which is needed for uniquely determining an outer marker
    // when they overlap (they may nest, but not partially overlap).
    var nextMarkerId = 0;
  
    // Create a marker, wire it up to the right lines, and
    function markText(doc, from, to, options, type) {
      // Shared markers (across linked documents) are handled separately
      // (markTextShared will call out to this again, once per
      // document).
      if (options && options.shared) return markTextShared(doc, from, to, options, type);
      // Ensure we are in an operation.
      if (doc.cm && !doc.cm.curOp) return operation(doc.cm, markText)(doc, from, to, options, type);
  
      var marker = new TextMarker(doc, type), diff = cmp(from, to);
      if (options) copyObj(options, marker, false);
      // Don't connect empty markers unless clearWhenEmpty is false
      if (diff > 0 || diff == 0 && marker.clearWhenEmpty !== false)
        return marker;
      if (marker.replacedWith) {
        // Showing up as a widget implies collapsed (widget replaces text)
        marker.collapsed = true;
        marker.widgetNode = elt("span", [marker.replacedWith], "CodeMirror-widget");
        if (!options.handleMouseEvents) marker.widgetNode.setAttribute("cm-ignore-events", "true");
        if (options.insertLeft) marker.widgetNode.insertLeft = true;
      }
      if (marker.collapsed) {
        if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
            from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
          throw new Error("Inserting collapsed marker partially overlapping an existing one");
        sawCollapsedSpans = true;
      }
  
      if (marker.addToHistory)
        addChangeToHistory(doc, {from: from, to: to, origin: "markText"}, doc.sel, NaN);
  
      var curLine = from.line, cm = doc.cm, updateMaxLine;
      doc.iter(curLine, to.line + 1, function(line) {
        if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(line) == cm.display.maxLine)
          updateMaxLine = true;
        if (marker.collapsed && curLine != from.line) updateLineHeight(line, 0);
        addMarkedSpan(line, new MarkedSpan(marker,
                                           curLine == from.line ? from.ch : null,
                                           curLine == to.line ? to.ch : null));
        ++curLine;
      });
      // lineIsHidden depends on the presence of the spans, so needs a second pass
      if (marker.collapsed) doc.iter(from.line, to.line + 1, function(line) {
        if (lineIsHidden(doc, line)) updateLineHeight(line, 0);
      });
  
      if (marker.clearOnEnter) on(marker, "beforeCursorEnter", function() { marker.clear(); });
  
      if (marker.readOnly) {
        sawReadOnlySpans = true;
        if (doc.history.done.length || doc.history.undone.length)
          doc.clearHistory();
      }
      if (marker.collapsed) {
        marker.id = ++nextMarkerId;
        marker.atomic = true;
      }
      if (cm) {
        // Sync editor state
        if (updateMaxLine) cm.curOp.updateMaxLine = true;
        if (marker.collapsed)
          regChange(cm, from.line, to.line + 1);
        else if (marker.className || marker.title || marker.startStyle || marker.endStyle || marker.css)
          for (var i = from.line; i <= to.line; i++) regLineChange(cm, i, "text");
        if (marker.atomic) reCheckSelection(cm.doc);
        signalLater(cm, "markerAdded", cm, marker);
      }
      return marker;
    }
  
    // SHARED TEXTMARKERS
  
    // A shared marker spans multiple linked documents. It is
    // implemented as a meta-marker-object controlling multiple normal
    // markers.
    var SharedTextMarker = CodeMirror.SharedTextMarker = function(markers, primary) {
      this.markers = markers;
      this.primary = primary;
      for (var i = 0; i < markers.length; ++i)
        markers[i].parent = this;
    };
    eventMixin(SharedTextMarker);
  
    SharedTextMarker.prototype.clear = function() {
      if (this.explicitlyCleared) return;
      this.explicitlyCleared = true;
      for (var i = 0; i < this.markers.length; ++i)
        this.markers[i].clear();
      signalLater(this, "clear");
    };
    SharedTextMarker.prototype.find = function(side, lineObj) {
      return this.primary.find(side, lineObj);
    };
  
    function markTextShared(doc, from, to, options, type) {
      options = copyObj(options);
      options.shared = false;
      var markers = [markText(doc, from, to, options, type)], primary = markers[0];
      var widget = options.widgetNode;
      linkedDocs(doc, function(doc) {
        if (widget) options.widgetNode = widget.cloneNode(true);
        markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
        for (var i = 0; i < doc.linked.length; ++i)
          if (doc.linked[i].isParent) return;
        primary = lst(markers);
      });
      return new SharedTextMarker(markers, primary);
    }
  
    function findSharedMarkers(doc) {
      return doc.findMarks(Pos(doc.first, 0), doc.clipPos(Pos(doc.lastLine())),
                           function(m) { return m.parent; });
    }
  
    function copySharedMarkers(doc, markers) {
      for (var i = 0; i < markers.length; i++) {
        var marker = markers[i], pos = marker.find();
        var mFrom = doc.clipPos(pos.from), mTo = doc.clipPos(pos.to);
        if (cmp(mFrom, mTo)) {
          var subMark = markText(doc, mFrom, mTo, marker.primary, marker.primary.type);
          marker.markers.push(subMark);
          subMark.parent = marker;
        }
      }
    }
  
    function detachSharedMarkers(markers) {
      for (var i = 0; i < markers.length; i++) {
        var marker = markers[i], linked = [marker.primary.doc];;
        linkedDocs(marker.primary.doc, function(d) { linked.push(d); });
        for (var j = 0; j < marker.markers.length; j++) {
          var subMarker = marker.markers[j];
          if (indexOf(linked, subMarker.doc) == -1) {
            subMarker.parent = null;
            marker.markers.splice(j--, 1);
          }
        }
      }
    }
  
    // TEXTMARKER SPANS
  
    function MarkedSpan(marker, from, to) {
      this.marker = marker;
      this.from = from; this.to = to;
    }
  
    // Search an array of spans for a span matching the given marker.
    function getMarkedSpanFor(spans, marker) {
      if (spans) for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if (span.marker == marker) return span;
      }
    }
    // Remove a span from an array, returning undefined if no spans are
    // left (we don't store arrays for lines without spans).
    function removeMarkedSpan(spans, span) {
      for (var r, i = 0; i < spans.length; ++i)
        if (spans[i] != span) (r || (r = [])).push(spans[i]);
      return r;
    }
    // Add a span to a line.
    function addMarkedSpan(line, span) {
      line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
      span.marker.attachLine(line);
    }
  
    // Used for the algorithm that adjusts markers for a change in the
    // document. These functions cut an array of spans at a given
    // character position, returning an array of remaining chunks (or
    // undefined if nothing remains).
    function markedSpansBefore(old, startCh, isInsert) {
      if (old) for (var i = 0, nw; i < old.length; ++i) {
        var span = old[i], marker = span.marker;
        var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
        if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
          var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh);
          (nw || (nw = [])).push(new MarkedSpan(marker, span.from, endsAfter ? null : span.to));
        }
      }
      return nw;
    }
    function markedSpansAfter(old, endCh, isInsert) {
      if (old) for (var i = 0, nw; i < old.length; ++i) {
        var span = old[i], marker = span.marker;
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= endCh : span.to > endCh);
        if (endsAfter || span.from == endCh && marker.type == "bookmark" && (!isInsert || span.marker.insertLeft)) {
          var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= endCh : span.from < endCh);
          (nw || (nw = [])).push(new MarkedSpan(marker, startsBefore ? null : span.from - endCh,
                                                span.to == null ? null : span.to - endCh));
        }
      }
      return nw;
    }
  
    // Given a change object, compute the new set of marker spans that
    // cover the line in which the change took place. Removes spans
    // entirely within the change, reconnects spans belonging to the
    // same marker that appear on both sides of the change, and cuts off
    // spans partially within the change. Returns an array of span
    // arrays with one element for each line in (after) the change.
    function stretchSpansOverChange(doc, change) {
      if (change.full) return null;
      var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
      var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
      if (!oldFirst && !oldLast) return null;
  
      var startCh = change.from.ch, endCh = change.to.ch, isInsert = cmp(change.from, change.to) == 0;
      // Get the spans that 'stick out' on both sides
      var first = markedSpansBefore(oldFirst, startCh, isInsert);
      var last = markedSpansAfter(oldLast, endCh, isInsert);
  
      // Next, merge those two ends
      var sameLine = change.text.length == 1, offset = lst(change.text).length + (sameLine ? startCh : 0);
      if (first) {
        // Fix up .to properties of first
        for (var i = 0; i < first.length; ++i) {
          var span = first[i];
          if (span.to == null) {
            var found = getMarkedSpanFor(last, span.marker);
            if (!found) span.to = startCh;
            else if (sameLine) span.to = found.to == null ? null : found.to + offset;
          }
        }
      }
      if (last) {
        // Fix up .from in last (or move them into first in case of sameLine)
        for (var i = 0; i < last.length; ++i) {
          var span = last[i];
          if (span.to != null) span.to += offset;
          if (span.from == null) {
            var found = getMarkedSpanFor(first, span.marker);
            if (!found) {
              span.from = offset;
              if (sameLine) (first || (first = [])).push(span);
            }
          } else {
            span.from += offset;
            if (sameLine) (first || (first = [])).push(span);
          }
        }
      }
      // Make sure we didn't create any zero-length spans
      if (first) first = clearEmptySpans(first);
      if (last && last != first) last = clearEmptySpans(last);
  
      var newMarkers = [first];
      if (!sameLine) {
        // Fill gap with whole-line-spans
        var gap = change.text.length - 2, gapMarkers;
        if (gap > 0 && first)
          for (var i = 0; i < first.length; ++i)
            if (first[i].to == null)
              (gapMarkers || (gapMarkers = [])).push(new MarkedSpan(first[i].marker, null, null));
        for (var i = 0; i < gap; ++i)
          newMarkers.push(gapMarkers);
        newMarkers.push(last);
      }
      return newMarkers;
    }
  
    // Remove spans that are empty and don't have a clearWhenEmpty
    // option of false.
    function clearEmptySpans(spans) {
      for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
          spans.splice(i--, 1);
      }
      if (!spans.length) return null;
      return spans;
    }
  
    // Used for un/re-doing changes from the history. Combines the
    // result of computing the existing spans with the set of spans that
    // existed in the history (so that deleting around a span and then
    // undoing brings back the span).
    function mergeOldSpans(doc, change) {
      var old = getOldSpans(doc, change);
      var stretched = stretchSpansOverChange(doc, change);
      if (!old) return stretched;
      if (!stretched) return old;
  
      for (var i = 0; i < old.length; ++i) {
        var oldCur = old[i], stretchCur = stretched[i];
        if (oldCur && stretchCur) {
          spans: for (var j = 0; j < stretchCur.length; ++j) {
            var span = stretchCur[j];
            for (var k = 0; k < oldCur.length; ++k)
              if (oldCur[k].marker == span.marker) continue spans;
            oldCur.push(span);
          }
        } else if (stretchCur) {
          old[i] = stretchCur;
        }
      }
      return old;
    }
  
    // Used to 'clip' out readOnly ranges when making a change.
    function removeReadOnlyRanges(doc, from, to) {
      var markers = null;
      doc.iter(from.line, to.line + 1, function(line) {
        if (line.markedSpans) for (var i = 0; i < line.markedSpans.length; ++i) {
          var mark = line.markedSpans[i].marker;
          if (mark.readOnly && (!markers || indexOf(markers, mark) == -1))
            (markers || (markers = [])).push(mark);
        }
      });
      if (!markers) return null;
      var parts = [{from: from, to: to}];
      for (var i = 0; i < markers.length; ++i) {
        var mk = markers[i], m = mk.find(0);
        for (var j = 0; j < parts.length; ++j) {
          var p = parts[j];
          if (cmp(p.to, m.from) < 0 || cmp(p.from, m.to) > 0) continue;
          var newParts = [j, 1], dfrom = cmp(p.from, m.from), dto = cmp(p.to, m.to);
          if (dfrom < 0 || !mk.inclusiveLeft && !dfrom)
            newParts.push({from: p.from, to: m.from});
          if (dto > 0 || !mk.inclusiveRight && !dto)
            newParts.push({from: m.to, to: p.to});
          parts.splice.apply(parts, newParts);
          j += newParts.length - 1;
        }
      }
      return parts;
    }
  
    // Connect or disconnect spans from a line.
    function detachMarkedSpans(line) {
      var spans = line.markedSpans;
      if (!spans) return;
      for (var i = 0; i < spans.length; ++i)
        spans[i].marker.detachLine(line);
      line.markedSpans = null;
    }
    function attachMarkedSpans(line, spans) {
      if (!spans) return;
      for (var i = 0; i < spans.length; ++i)
        spans[i].marker.attachLine(line);
      line.markedSpans = spans;
    }
  
    // Helpers used when computing which overlapping collapsed span
    // counts as the larger one.
    function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0; }
    function extraRight(marker) { return marker.inclusiveRight ? 1 : 0; }
  
    // Returns a number indicating which of two overlapping collapsed
    // spans is larger (and thus includes the other). Falls back to
    // comparing ids when the spans cover exactly the same range.
    function compareCollapsedMarkers(a, b) {
      var lenDiff = a.lines.length - b.lines.length;
      if (lenDiff != 0) return lenDiff;
      var aPos = a.find(), bPos = b.find();
      var fromCmp = cmp(aPos.from, bPos.from) || extraLeft(a) - extraLeft(b);
      if (fromCmp) return -fromCmp;
      var toCmp = cmp(aPos.to, bPos.to) || extraRight(a) - extraRight(b);
      if (toCmp) return toCmp;
      return b.id - a.id;
    }
  
    // Find out whether a line ends or starts in a collapsed span. If
    // so, return the marker for that span.
    function collapsedSpanAtSide(line, start) {
      var sps = sawCollapsedSpans && line.markedSpans, found;
      if (sps) for (var sp, i = 0; i < sps.length; ++i) {
        sp = sps[i];
        if (sp.marker.collapsed && (start ? sp.from : sp.to) == null &&
            (!found || compareCollapsedMarkers(found, sp.marker) < 0))
          found = sp.marker;
      }
      return found;
    }
    function collapsedSpanAtStart(line) { return collapsedSpanAtSide(line, true); }
    function collapsedSpanAtEnd(line) { return collapsedSpanAtSide(line, false); }
  
    // Test whether there exists a collapsed span that partially
    // overlaps (covers the start or end, but not both) of a new span.
    // Such overlap is not allowed.
    function conflictingCollapsedRange(doc, lineNo, from, to, marker) {
      var line = getLine(doc, lineNo);
      var sps = sawCollapsedSpans && line.markedSpans;
      if (sps) for (var i = 0; i < sps.length; ++i) {
        var sp = sps[i];
        if (!sp.marker.collapsed) continue;
        var found = sp.marker.find(0);
        var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
        var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
        if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) continue;
        if (fromCmp <= 0 && (cmp(found.to, from) > 0 || (sp.marker.inclusiveRight && marker.inclusiveLeft)) ||
            fromCmp >= 0 && (cmp(found.from, to) < 0 || (sp.marker.inclusiveLeft && marker.inclusiveRight)))
          return true;
      }
    }
  
    // A visual line is a line as drawn on the screen. Folding, for
    // example, can cause multiple logical lines to appear on the same
    // visual line. This finds the start of the visual line that the
    // given line is part of (usually that is the line itself).
    function visualLine(line) {
      var merged;
      while (merged = collapsedSpanAtStart(line))
        line = merged.find(-1, true).line;
      return line;
    }
  
    // Returns an array of logical lines that continue the visual line
    // started by the argument, or undefined if there are no such lines.
    function visualLineContinued(line) {
      var merged, lines;
      while (merged = collapsedSpanAtEnd(line)) {
        line = merged.find(1, true).line;
        (lines || (lines = [])).push(line);
      }
      return lines;
    }
  
    // Get the line number of the start of the visual line that the
    // given line number is part of.
    function visualLineNo(doc, lineN) {
      var line = getLine(doc, lineN), vis = visualLine(line);
      if (line == vis) return lineN;
      return lineNo(vis);
    }
    // Get the line number of the start of the next visual line after
    // the given line.
    function visualLineEndNo(doc, lineN) {
      if (lineN > doc.lastLine()) return lineN;
      var line = getLine(doc, lineN), merged;
      if (!lineIsHidden(doc, line)) return lineN;
      while (merged = collapsedSpanAtEnd(line))
        line = merged.find(1, true).line;
      return lineNo(line) + 1;
    }
  
    // Compute whether a line is hidden. Lines count as hidden when they
    // are part of a visual line that starts with another line, or when
    // they are entirely covered by collapsed, non-widget span.
    function lineIsHidden(doc, line) {
      var sps = sawCollapsedSpans && line.markedSpans;
      if (sps) for (var sp, i = 0; i < sps.length; ++i) {
        sp = sps[i];
        if (!sp.marker.collapsed) continue;
        if (sp.from == null) return true;
        if (sp.marker.widgetNode) continue;
        if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
          return true;
      }
    }
    function lineIsHiddenInner(doc, line, span) {
      if (span.to == null) {
        var end = span.marker.find(1, true);
        return lineIsHiddenInner(doc, end.line, getMarkedSpanFor(end.line.markedSpans, span.marker));
      }
      if (span.marker.inclusiveRight && span.to == line.text.length)
        return true;
      for (var sp, i = 0; i < line.markedSpans.length; ++i) {
        sp = line.markedSpans[i];
        if (sp.marker.collapsed && !sp.marker.widgetNode && sp.from == span.to &&
            (sp.to == null || sp.to != span.from) &&
            (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
            lineIsHiddenInner(doc, line, sp)) return true;
      }
    }
  
    // LINE WIDGETS
  
    // Line widgets are block elements displayed above or below a line.
  
    var LineWidget = CodeMirror.LineWidget = function(doc, node, options) {
      if (options) for (var opt in options) if (options.hasOwnProperty(opt))
        this[opt] = options[opt];
      this.doc = doc;
      this.node = node;
    };
    eventMixin(LineWidget);
  
    function adjustScrollWhenAboveVisible(cm, line, diff) {
      if (heightAtLine(line) < ((cm.curOp && cm.curOp.scrollTop) || cm.doc.scrollTop))
        addToScrollPos(cm, null, diff);
    }
  
    LineWidget.prototype.clear = function() {
      var cm = this.doc.cm, ws = this.line.widgets, line = this.line, no = lineNo(line);
      if (no == null || !ws) return;
      for (var i = 0; i < ws.length; ++i) if (ws[i] == this) ws.splice(i--, 1);
      if (!ws.length) line.widgets = null;
      var height = widgetHeight(this);
      updateLineHeight(line, Math.max(0, line.height - height));
      if (cm) runInOp(cm, function() {
        adjustScrollWhenAboveVisible(cm, line, -height);
        regLineChange(cm, no, "widget");
      });
    };
    LineWidget.prototype.changed = function() {
      var oldH = this.height, cm = this.doc.cm, line = this.line;
      this.height = null;
      var diff = widgetHeight(this) - oldH;
      if (!diff) return;
      updateLineHeight(line, line.height + diff);
      if (cm) runInOp(cm, function() {
        cm.curOp.forceUpdate = true;
        adjustScrollWhenAboveVisible(cm, line, diff);
      });
    };
  
    function widgetHeight(widget) {
      if (widget.height != null) return widget.height;
      var cm = widget.doc.cm;
      if (!cm) return 0;
      if (!contains(document.body, widget.node)) {
        var parentStyle = "position: relative;";
        if (widget.coverGutter)
          parentStyle += "margin-left: -" + cm.display.gutters.offsetWidth + "px;";
        if (widget.noHScroll)
          parentStyle += "width: " + cm.display.wrapper.clientWidth + "px;";
        removeChildrenAndAdd(cm.display.measure, elt("div", [widget.node], null, parentStyle));
      }
      return widget.height = widget.node.offsetHeight;
    }
  
    function addLineWidget(doc, handle, node, options) {
      var widget = new LineWidget(doc, node, options);
      var cm = doc.cm;
      if (cm && widget.noHScroll) cm.display.alignWidgets = true;
      changeLine(doc, handle, "widget", function(line) {
        var widgets = line.widgets || (line.widgets = []);
        if (widget.insertAt == null) widgets.push(widget);
        else widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget);
        widget.line = line;
        if (cm && !lineIsHidden(doc, line)) {
          var aboveVisible = heightAtLine(line) < doc.scrollTop;
          updateLineHeight(line, line.height + widgetHeight(widget));
          if (aboveVisible) addToScrollPos(cm, null, widget.height);
          cm.curOp.forceUpdate = true;
        }
        return true;
      });
      return widget;
    }
  
    // LINE DATA STRUCTURE
  
    // Line objects. These hold state related to a line, including
    // highlighting info (the styles array).
    var Line = CodeMirror.Line = function(text, markedSpans, estimateHeight) {
      this.text = text;
      attachMarkedSpans(this, markedSpans);
      this.height = estimateHeight ? estimateHeight(this) : 1;
    };
    eventMixin(Line);
    Line.prototype.lineNo = function() { return lineNo(this); };
  
    // Change the content (text, markers) of a line. Automatically
    // invalidates cached information and tries to re-estimate the
    // line's height.
    function updateLine(line, text, markedSpans, estimateHeight) {
      line.text = text;
      if (line.stateAfter) line.stateAfter = null;
      if (line.styles) line.styles = null;
      if (line.order != null) line.order = null;
      detachMarkedSpans(line);
      attachMarkedSpans(line, markedSpans);
      var estHeight = estimateHeight ? estimateHeight(line) : 1;
      if (estHeight != line.height) updateLineHeight(line, estHeight);
    }
  
    // Detach a line from the document tree and its markers.
    function cleanUpLine(line) {
      line.parent = null;
      detachMarkedSpans(line);
    }
  
    function extractLineClasses(type, output) {
      if (type) for (;;) {
        var lineClass = type.match(/(?:^|\s+)line-(background-)?(\S+)/);
        if (!lineClass) break;
        type = type.slice(0, lineClass.index) + type.slice(lineClass.index + lineClass[0].length);
        var prop = lineClass[1] ? "bgClass" : "textClass";
        if (output[prop] == null)
          output[prop] = lineClass[2];
        else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(output[prop]))
          output[prop] += " " + lineClass[2];
      }
      return type;
    }
  
    function callBlankLine(mode, state) {
      if (mode.blankLine) return mode.blankLine(state);
      if (!mode.innerMode) return;
      var inner = CodeMirror.innerMode(mode, state);
      if (inner.mode.blankLine) return inner.mode.blankLine(inner.state);
    }
  
    function readToken(mode, stream, state, inner) {
      for (var i = 0; i < 10; i++) {
        if (inner) inner[0] = CodeMirror.innerMode(mode, state).mode;
        var style = mode.token(stream, state);
        if (stream.pos > stream.start) return style;
      }
      throw new Error("Mode " + mode.name + " failed to advance stream.");
    }
  
    // Utility for getTokenAt and getLineTokens
    function takeToken(cm, pos, precise, asArray) {
      function getObj(copy) {
        return {start: stream.start, end: stream.pos,
                string: stream.current(),
                type: style || null,
                state: copy ? copyState(doc.mode, state) : state};
      }
  
      var doc = cm.doc, mode = doc.mode, style;
      pos = clipPos(doc, pos);
      var line = getLine(doc, pos.line), state = getStateBefore(cm, pos.line, precise);
      var stream = new StringStream(line.text, cm.options.tabSize), tokens;
      if (asArray) tokens = [];
      while ((asArray || stream.pos < pos.ch) && !stream.eol()) {
        stream.start = stream.pos;
        style = readToken(mode, stream, state);
        if (asArray) tokens.push(getObj(true));
      }
      return asArray ? tokens : getObj();
    }
  
    // Run the given mode's parser over a line, calling f for each token.
    function runMode(cm, text, mode, state, f, lineClasses, forceToEnd) {
      var flattenSpans = mode.flattenSpans;
      if (flattenSpans == null) flattenSpans = cm.options.flattenSpans;
      var curStart = 0, curStyle = null;
      var stream = new StringStream(text, cm.options.tabSize), style;
      var inner = cm.options.addModeClass && [null];
      if (text == "") extractLineClasses(callBlankLine(mode, state), lineClasses);
      while (!stream.eol()) {
        if (stream.pos > cm.options.maxHighlightLength) {
          flattenSpans = false;
          if (forceToEnd) processLine(cm, text, state, stream.pos);
          stream.pos = text.length;
          style = null;
        } else {
          style = extractLineClasses(readToken(mode, stream, state, inner), lineClasses);
        }
        if (inner) {
          var mName = inner[0].name;
          if (mName) style = "m-" + (style ? mName + " " + style : mName);
        }
        if (!flattenSpans || curStyle != style) {
          while (curStart < stream.start) {
            curStart = Math.min(stream.start, curStart + 50000);
            f(curStart, curStyle);
          }
          curStyle = style;
        }
        stream.start = stream.pos;
      }
      while (curStart < stream.pos) {
        // Webkit seems to refuse to render text nodes longer than 57444 characters
        var pos = Math.min(stream.pos, curStart + 50000);
        f(pos, curStyle);
        curStart = pos;
      }
    }
  
    // Compute a style array (an array starting with a mode generation
    // -- for invalidation -- followed by pairs of end positions and
    // style strings), which is used to highlight the tokens on the
    // line.
    function highlightLine(cm, line, state, forceToEnd) {
      // A styles array always starts with a number identifying the
      // mode/overlays that it is based on (for easy invalidation).
      var st = [cm.state.modeGen], lineClasses = {};
      // Compute the base array of styles
      runMode(cm, line.text, cm.doc.mode, state, function(end, style) {
        st.push(end, style);
      }, lineClasses, forceToEnd);
  
      // Run overlays, adjust style array.
      for (var o = 0; o < cm.state.overlays.length; ++o) {
        var overlay = cm.state.overlays[o], i = 1, at = 0;
        runMode(cm, line.text, overlay.mode, true, function(end, style) {
          var start = i;
          // Ensure there's a token end at the current position, and that i points at it
          while (at < end) {
            var i_end = st[i];
            if (i_end > end)
              st.splice(i, 1, end, st[i+1], i_end);
            i += 2;
            at = Math.min(end, i_end);
          }
          if (!style) return;
          if (overlay.opaque) {
            st.splice(start, i - start, end, "cm-overlay " + style);
            i = start + 2;
          } else {
            for (; start < i; start += 2) {
              var cur = st[start+1];
              st[start+1] = (cur ? cur + " " : "") + "cm-overlay " + style;
            }
          }
        }, lineClasses);
      }
  
      return {styles: st, classes: lineClasses.bgClass || lineClasses.textClass ? lineClasses : null};
    }
  
    function getLineStyles(cm, line, updateFrontier) {
      if (!line.styles || line.styles[0] != cm.state.modeGen) {
        var result = highlightLine(cm, line, line.stateAfter = getStateBefore(cm, lineNo(line)));
        line.styles = result.styles;
        if (result.classes) line.styleClasses = result.classes;
        else if (line.styleClasses) line.styleClasses = null;
        if (updateFrontier === cm.doc.frontier) cm.doc.frontier++;
      }
      return line.styles;
    }
  
    // Lightweight form of highlight -- proceed over this line and
    // update state, but don't save a style array. Used for lines that
    // aren't currently visible.
    function processLine(cm, text, state, startAt) {
      var mode = cm.doc.mode;
      var stream = new StringStream(text, cm.options.tabSize);
      stream.start = stream.pos = startAt || 0;
      if (text == "") callBlankLine(mode, state);
      while (!stream.eol() && stream.pos <= cm.options.maxHighlightLength) {
        readToken(mode, stream, state);
        stream.start = stream.pos;
      }
    }
  
    // Convert a style as returned by a mode (either null, or a string
    // containing one or more styles) to a CSS style. This is cached,
    // and also looks for line-wide styles.
    var styleToClassCache = {}, styleToClassCacheWithMode = {};
    function interpretTokenStyle(style, options) {
      if (!style || /^\s*$/.test(style)) return null;
      var cache = options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
      return cache[style] ||
        (cache[style] = style.replace(/\S+/g, "cm-$&"));
    }
  
    // Render the DOM representation of the text of a line. Also builds
    // up a 'line map', which points at the DOM nodes that represent
    // specific stretches of text, and is used by the measuring code.
    // The returned object contains the DOM node, this map, and
    // information about line-wide styles that were set by the mode.
    function buildLineContent(cm, lineView) {
      // The padding-right forces the element to have a 'border', which
      // is needed on Webkit to be able to get line-level bounding
      // rectangles for it (in measureChar).
      var content = elt("span", null, null, webkit ? "padding-right: .1px" : null);
      var builder = {pre: elt("pre", [content], "CodeMirror-line"), content: content,
                     col: 0, pos: 0, cm: cm,
                     splitSpaces: (ie || webkit) && cm.getOption("lineWrapping")};
      lineView.measure = {};
  
      // Iterate over the logical lines that make up this visual line.
      for (var i = 0; i <= (lineView.rest ? lineView.rest.length : 0); i++) {
        var line = i ? lineView.rest[i - 1] : lineView.line, order;
        builder.pos = 0;
        builder.addToken = buildToken;
        // Optionally wire in some hacks into the token-rendering
        // algorithm, to deal with browser quirks.
        if (hasBadBidiRects(cm.display.measure) && (order = getOrder(line)))
          builder.addToken = buildTokenBadBidi(builder.addToken, order);
        builder.map = [];
        var allowFrontierUpdate = lineView != cm.display.externalMeasured && lineNo(line);
        insertLineContent(line, builder, getLineStyles(cm, line, allowFrontierUpdate));
        if (line.styleClasses) {
          if (line.styleClasses.bgClass)
            builder.bgClass = joinClasses(line.styleClasses.bgClass, builder.bgClass || "");
          if (line.styleClasses.textClass)
            builder.textClass = joinClasses(line.styleClasses.textClass, builder.textClass || "");
        }
  
        // Ensure at least a single node is present, for measuring.
        if (builder.map.length == 0)
          builder.map.push(0, 0, builder.content.appendChild(zeroWidthElement(cm.display.measure)));
  
        // Store the map and a cache object for the current logical line
        if (i == 0) {
          lineView.measure.map = builder.map;
          lineView.measure.cache = {};
        } else {
          (lineView.measure.maps || (lineView.measure.maps = [])).push(builder.map);
          (lineView.measure.caches || (lineView.measure.caches = [])).push({});
        }
      }
  
      // See issue #2901
      if (webkit && /\bcm-tab\b/.test(builder.content.lastChild.className))
        builder.content.className = "cm-tab-wrap-hack";
  
      signal(cm, "renderLine", cm, lineView.line, builder.pre);
      if (builder.pre.className)
        builder.textClass = joinClasses(builder.pre.className, builder.textClass || "");
  
      return builder;
    }
  
    function defaultSpecialCharPlaceholder(ch) {
      var token = elt("span", "\u2022", "cm-invalidchar");
      token.title = "\\u" + ch.charCodeAt(0).toString(16);
      token.setAttribute("aria-label", token.title);
      return token;
    }
  
    // Build up the DOM representation for a single token, and add it to
    // the line map. Takes care to render special characters separately.
    function buildToken(builder, text, style, startStyle, endStyle, title, css) {
      if (!text) return;
      var displayText = builder.splitSpaces ? text.replace(/ {3,}/g, splitSpaces) : text;
      var special = builder.cm.state.specialChars, mustWrap = false;
      if (!special.test(text)) {
        builder.col += text.length;
        var content = document.createTextNode(displayText);
        builder.map.push(builder.pos, builder.pos + text.length, content);
        if (ie && ie_version < 9) mustWrap = true;
        builder.pos += text.length;
      } else {
        var content = document.createDocumentFragment(), pos = 0;
        while (true) {
          special.lastIndex = pos;
          var m = special.exec(text);
          var skipped = m ? m.index - pos : text.length - pos;
          if (skipped) {
            var txt = document.createTextNode(displayText.slice(pos, pos + skipped));
            if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
            else content.appendChild(txt);
            builder.map.push(builder.pos, builder.pos + skipped, txt);
            builder.col += skipped;
            builder.pos += skipped;
          }
          if (!m) break;
          pos += skipped + 1;
          if (m[0] == "\t") {
            var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
            var txt = content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
            txt.setAttribute("role", "presentation");
            txt.setAttribute("cm-text", "\t");
            builder.col += tabWidth;
          } else if (m[0] == "\r" || m[0] == "\n") {
            var txt = content.appendChild(elt("span", m[0] == "\r" ? "␍" : "␤", "cm-invalidchar"));
            txt.setAttribute("cm-text", m[0]);
            builder.col += 1;
          } else {
            var txt = builder.cm.options.specialCharPlaceholder(m[0]);
            txt.setAttribute("cm-text", m[0]);
            if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
            else content.appendChild(txt);
            builder.col += 1;
          }
          builder.map.push(builder.pos, builder.pos + 1, txt);
          builder.pos++;
        }
      }
      if (style || startStyle || endStyle || mustWrap || css) {
        var fullStyle = style || "";
        if (startStyle) fullStyle += startStyle;
        if (endStyle) fullStyle += endStyle;
        var token = elt("span", [content], fullStyle, css);
        if (title) token.title = title;
        return builder.content.appendChild(token);
      }
      builder.content.appendChild(content);
    }
  
    function splitSpaces(old) {
      var out = " ";
      for (var i = 0; i < old.length - 2; ++i) out += i % 2 ? " " : "\u00a0";
      out += " ";
      return out;
    }
  
    // Work around nonsense dimensions being reported for stretches of
    // right-to-left text.
    function buildTokenBadBidi(inner, order) {
      return function(builder, text, style, startStyle, endStyle, title, css) {
        style = style ? style + " cm-force-border" : "cm-force-border";
        var start = builder.pos, end = start + text.length;
        for (;;) {
          // Find the part that overlaps with the start of this text
          for (var i = 0; i < order.length; i++) {
            var part = order[i];
            if (part.to > start && part.from <= start) break;
          }
          if (part.to >= end) return inner(builder, text, style, startStyle, endStyle, title, css);
          inner(builder, text.slice(0, part.to - start), style, startStyle, null, title, css);
          startStyle = null;
          text = text.slice(part.to - start);
          start = part.to;
        }
      };
    }
  
    function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
      var widget = !ignoreWidget && marker.widgetNode;
      if (widget) builder.map.push(builder.pos, builder.pos + size, widget);
      if (!ignoreWidget && builder.cm.display.input.needsContentAttribute) {
        if (!widget)
          widget = builder.content.appendChild(document.createElement("span"));
        widget.setAttribute("cm-marker", marker.id);
      }
      if (widget) {
        builder.cm.display.input.setUneditable(widget);
        builder.content.appendChild(widget);
      }
      builder.pos += size;
    }
  
    // Outputs a number of spans to make up a line, taking highlighting
    // and marked text into account.
    function insertLineContent(line, builder, styles) {
      var spans = line.markedSpans, allText = line.text, at = 0;
      if (!spans) {
        for (var i = 1; i < styles.length; i+=2)
          builder.addToken(builder, allText.slice(at, at = styles[i]), interpretTokenStyle(styles[i+1], builder.cm.options));
        return;
      }
  
      var len = allText.length, pos = 0, i = 1, text = "", style, css;
      var nextChange = 0, spanStyle, spanEndStyle, spanStartStyle, title, collapsed;
      for (;;) {
        if (nextChange == pos) { // Update current marker set
          spanStyle = spanEndStyle = spanStartStyle = title = css = "";
          collapsed = null; nextChange = Infinity;
          var foundBookmarks = [];
          for (var j = 0; j < spans.length; ++j) {
            var sp = spans[j], m = sp.marker;
            if (m.type == "bookmark" && sp.from == pos && m.widgetNode) {
              foundBookmarks.push(m);
            } else if (sp.from <= pos && (sp.to == null || sp.to > pos || m.collapsed && sp.to == pos && sp.from == pos)) {
              if (sp.to != null && sp.to != pos && nextChange > sp.to) {
                nextChange = sp.to;
                spanEndStyle = "";
              }
              if (m.className) spanStyle += " " + m.className;
              if (m.css) css = m.css;
              if (m.startStyle && sp.from == pos) spanStartStyle += " " + m.startStyle;
              if (m.endStyle && sp.to == nextChange) spanEndStyle += " " + m.endStyle;
              if (m.title && !title) title = m.title;
              if (m.collapsed && (!collapsed || compareCollapsedMarkers(collapsed.marker, m) < 0))
                collapsed = sp;
            } else if (sp.from > pos && nextChange > sp.from) {
              nextChange = sp.from;
            }
          }
          if (collapsed && (collapsed.from || 0) == pos) {
            buildCollapsedSpan(builder, (collapsed.to == null ? len + 1 : collapsed.to) - pos,
                               collapsed.marker, collapsed.from == null);
            if (collapsed.to == null) return;
            if (collapsed.to == pos) collapsed = false;
          }
          if (!collapsed && foundBookmarks.length) for (var j = 0; j < foundBookmarks.length; ++j)
            buildCollapsedSpan(builder, 0, foundBookmarks[j]);
        }
        if (pos >= len) break;
  
        var upto = Math.min(len, nextChange);
        while (true) {
          if (text) {
            var end = pos + text.length;
            if (!collapsed) {
              var tokenText = end > upto ? text.slice(0, upto - pos) : text;
              builder.addToken(builder, tokenText, style ? style + spanStyle : spanStyle,
                               spanStartStyle, pos + tokenText.length == nextChange ? spanEndStyle : "", title, css);
            }
            if (end >= upto) {text = text.slice(upto - pos); pos = upto; break;}
            pos = end;
            spanStartStyle = "";
          }
          text = allText.slice(at, at = styles[i++]);
          style = interpretTokenStyle(styles[i++], builder.cm.options);
        }
      }
    }
  
    // DOCUMENT DATA STRUCTURE
  
    // By default, updates that start and end at the beginning of a line
    // are treated specially, in order to make the association of line
    // widgets and marker elements with the text behave more intuitive.
    function isWholeLineUpdate(doc, change) {
      return change.from.ch == 0 && change.to.ch == 0 && lst(change.text) == "" &&
        (!doc.cm || doc.cm.options.wholeLineUpdateBefore);
    }
  
    // Perform a change on the document data structure.
    function updateDoc(doc, change, markedSpans, estimateHeight) {
      function spansFor(n) {return markedSpans ? markedSpans[n] : null;}
      function update(line, text, spans) {
        updateLine(line, text, spans, estimateHeight);
        signalLater(line, "change", line, change);
      }
      function linesFor(start, end) {
        for (var i = start, result = []; i < end; ++i)
          result.push(new Line(text[i], spansFor(i), estimateHeight));
        return result;
      }
  
      var from = change.from, to = change.to, text = change.text;
      var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
      var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;
  
      // Adjust the line structure
      if (change.full) {
        doc.insert(0, linesFor(0, text.length));
        doc.remove(text.length, doc.size - text.length);
      } else if (isWholeLineUpdate(doc, change)) {
        // This is a whole-line replace. Treated specially to make
        // sure line objects move the way they are supposed to.
        var added = linesFor(0, text.length - 1);
        update(lastLine, lastLine.text, lastSpans);
        if (nlines) doc.remove(from.line, nlines);
        if (added.length) doc.insert(from.line, added);
      } else if (firstLine == lastLine) {
        if (text.length == 1) {
          update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
        } else {
          var added = linesFor(1, text.length - 1);
          added.push(new Line(lastText + firstLine.text.slice(to.ch), lastSpans, estimateHeight));
          update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
          doc.insert(from.line + 1, added);
        }
      } else if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0] + lastLine.text.slice(to.ch), spansFor(0));
        doc.remove(from.line + 1, nlines);
      } else {
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
        update(lastLine, lastText + lastLine.text.slice(to.ch), lastSpans);
        var added = linesFor(1, text.length - 1);
        if (nlines > 1) doc.remove(from.line + 1, nlines - 1);
        doc.insert(from.line + 1, added);
      }
  
      signalLater(doc, "change", doc, change);
    }
  
    // The document is represented as a BTree consisting of leaves, with
    // chunk of lines in them, and branches, with up to ten leaves or
    // other branch nodes below them. The top node is always a branch
    // node, and is the document object itself (meaning it has
    // additional methods and properties).
    //
    // All nodes have parent links. The tree is used both to go from
    // line numbers to line objects, and to go from objects to numbers.
    // It also indexes by height, and is used to convert between height
    // and line object, and to find the total height of the document.
    //
    // See also http://marijnhaverbeke.nl/blog/codemirror-line-tree.html
  
    function LeafChunk(lines) {
      this.lines = lines;
      this.parent = null;
      for (var i = 0, height = 0; i < lines.length; ++i) {
        lines[i].parent = this;
        height += lines[i].height;
      }
      this.height = height;
    }
  
    LeafChunk.prototype = {
      chunkSize: function() { return this.lines.length; },
      // Remove the n lines at offset 'at'.
      removeInner: function(at, n) {
        for (var i = at, e = at + n; i < e; ++i) {
          var line = this.lines[i];
          this.height -= line.height;
          cleanUpLine(line);
          signalLater(line, "delete");
        }
        this.lines.splice(at, n);
      },
      // Helper used to collapse a small branch into a single leaf.
      collapse: function(lines) {
        lines.push.apply(lines, this.lines);
      },
      // Insert the given array of lines at offset 'at', count them as
      // having the given height.
      insertInner: function(at, lines, height) {
        this.height += height;
        this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
        for (var i = 0; i < lines.length; ++i) lines[i].parent = this;
      },
      // Used to iterate over a part of the tree.
      iterN: function(at, n, op) {
        for (var e = at + n; at < e; ++at)
          if (op(this.lines[at])) return true;
      }
    };
  
    function BranchChunk(children) {
      this.children = children;
      var size = 0, height = 0;
      for (var i = 0; i < children.length; ++i) {
        var ch = children[i];
        size += ch.chunkSize(); height += ch.height;
        ch.parent = this;
      }
      this.size = size;
      this.height = height;
      this.parent = null;
    }
  
    BranchChunk.prototype = {
      chunkSize: function() { return this.size; },
      removeInner: function(at, n) {
        this.size -= n;
        for (var i = 0; i < this.children.length; ++i) {
          var child = this.children[i], sz = child.chunkSize();
          if (at < sz) {
            var rm = Math.min(n, sz - at), oldHeight = child.height;
            child.removeInner(at, rm);
            this.height -= oldHeight - child.height;
            if (sz == rm) { this.children.splice(i--, 1); child.parent = null; }
            if ((n -= rm) == 0) break;
            at = 0;
          } else at -= sz;
        }
        // If the result is smaller than 25 lines, ensure that it is a
        // single leaf node.
        if (this.size - n < 25 &&
            (this.children.length > 1 || !(this.children[0] instanceof LeafChunk))) {
          var lines = [];
          this.collapse(lines);
          this.children = [new LeafChunk(lines)];
          this.children[0].parent = this;
        }
      },
      collapse: function(lines) {
        for (var i = 0; i < this.children.length; ++i) this.children[i].collapse(lines);
      },
      insertInner: function(at, lines, height) {
        this.size += lines.length;
        this.height += height;
        for (var i = 0; i < this.children.length; ++i) {
          var child = this.children[i], sz = child.chunkSize();
          if (at <= sz) {
            child.insertInner(at, lines, height);
            if (child.lines && child.lines.length > 50) {
              while (child.lines.length > 50) {
                var spilled = child.lines.splice(child.lines.length - 25, 25);
                var newleaf = new LeafChunk(spilled);
                child.height -= newleaf.height;
                this.children.splice(i + 1, 0, newleaf);
                newleaf.parent = this;
              }
              this.maybeSpill();
            }
            break;
          }
          at -= sz;
        }
      },
      // When a node has grown, check whether it should be split.
      maybeSpill: function() {
        if (this.children.length <= 10) return;
        var me = this;
        do {
          var spilled = me.children.splice(me.children.length - 5, 5);
          var sibling = new BranchChunk(spilled);
          if (!me.parent) { // Become the parent node
            var copy = new BranchChunk(me.children);
            copy.parent = me;
            me.children = [copy, sibling];
            me = copy;
          } else {
            me.size -= sibling.size;
            me.height -= sibling.height;
            var myIndex = indexOf(me.parent.children, me);
            me.parent.children.splice(myIndex + 1, 0, sibling);
          }
          sibling.parent = me.parent;
        } while (me.children.length > 10);
        me.parent.maybeSpill();
      },
      iterN: function(at, n, op) {
        for (var i = 0; i < this.children.length; ++i) {
          var child = this.children[i], sz = child.chunkSize();
          if (at < sz) {
            var used = Math.min(n, sz - at);
            if (child.iterN(at, used, op)) return true;
            if ((n -= used) == 0) break;
            at = 0;
          } else at -= sz;
        }
      }
    };
  
    var nextDocId = 0;
    var Doc = CodeMirror.Doc = function(text, mode, firstLine, lineSep) {
      if (!(this instanceof Doc)) return new Doc(text, mode, firstLine, lineSep);
      if (firstLine == null) firstLine = 0;
  
      BranchChunk.call(this, [new LeafChunk([new Line("", null)])]);
      this.first = firstLine;
      this.scrollTop = this.scrollLeft = 0;
      this.cantEdit = false;
      this.cleanGeneration = 1;
      this.frontier = firstLine;
      var start = Pos(firstLine, 0);
      this.sel = simpleSelection(start);
      this.history = new History(null);
      this.id = ++nextDocId;
      this.modeOption = mode;
      this.lineSep = lineSep;
  
      if (typeof text == "string") text = this.splitLines(text);
      updateDoc(this, {from: start, to: start, text: text});
      setSelection(this, simpleSelection(start), sel_dontScroll);
    };
  
    Doc.prototype = createObj(BranchChunk.prototype, {
      constructor: Doc,
      // Iterate over the document. Supports two forms -- with only one
      // argument, it calls that for each line in the document. With
      // three, it iterates over the range given by the first two (with
      // the second being non-inclusive).
      iter: function(from, to, op) {
        if (op) this.iterN(from - this.first, to - from, op);
        else this.iterN(this.first, this.first + this.size, from);
      },
  
      // Non-public interface for adding and removing lines.
      insert: function(at, lines) {
        var height = 0;
        for (var i = 0; i < lines.length; ++i) height += lines[i].height;
        this.insertInner(at - this.first, lines, height);
      },
      remove: function(at, n) { this.removeInner(at - this.first, n); },
  
      // From here, the methods are part of the public interface. Most
      // are also available from CodeMirror (editor) instances.
  
      getValue: function(lineSep) {
        var lines = getLines(this, this.first, this.first + this.size);
        if (lineSep === false) return lines;
        return lines.join(lineSep || this.lineSeparator());
      },
      setValue: docMethodOp(function(code) {
        var top = Pos(this.first, 0), last = this.first + this.size - 1;
        makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                          text: this.splitLines(code), origin: "setValue", full: true}, true);
        setSelection(this, simpleSelection(top));
      }),
      replaceRange: function(code, from, to, origin) {
        from = clipPos(this, from);
        to = to ? clipPos(this, to) : from;
        replaceRange(this, code, from, to, origin);
      },
      getRange: function(from, to, lineSep) {
        var lines = getBetween(this, clipPos(this, from), clipPos(this, to));
        if (lineSep === false) return lines;
        return lines.join(lineSep || this.lineSeparator());
      },
  
      getLine: function(line) {var l = this.getLineHandle(line); return l && l.text;},
  
      getLineHandle: function(line) {if (isLine(this, line)) return getLine(this, line);},
      getLineNumber: function(line) {return lineNo(line);},
  
      getLineHandleVisualStart: function(line) {
        if (typeof line == "number") line = getLine(this, line);
        return visualLine(line);
      },
  
      lineCount: function() {return this.size;},
      firstLine: function() {return this.first;},
      lastLine: function() {return this.first + this.size - 1;},
  
      clipPos: function(pos) {return clipPos(this, pos);},
  
      getCursor: function(start) {
        var range = this.sel.primary(), pos;
        if (start == null || start == "head") pos = range.head;
        else if (start == "anchor") pos = range.anchor;
        else if (start == "end" || start == "to" || start === false) pos = range.to();
        else pos = range.from();
        return pos;
      },
      listSelections: function() { return this.sel.ranges; },
      somethingSelected: function() {return this.sel.somethingSelected();},
  
      setCursor: docMethodOp(function(line, ch, options) {
        setSimpleSelection(this, clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line), null, options);
      }),
      setSelection: docMethodOp(function(anchor, head, options) {
        setSimpleSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), options);
      }),
      extendSelection: docMethodOp(function(head, other, options) {
        extendSelection(this, clipPos(this, head), other && clipPos(this, other), options);
      }),
      extendSelections: docMethodOp(function(heads, options) {
        extendSelections(this, clipPosArray(this, heads, options));
      }),
      extendSelectionsBy: docMethodOp(function(f, options) {
        extendSelections(this, map(this.sel.ranges, f), options);
      }),
      setSelections: docMethodOp(function(ranges, primary, options) {
        if (!ranges.length) return;
        for (var i = 0, out = []; i < ranges.length; i++)
          out[i] = new Range(clipPos(this, ranges[i].anchor),
                             clipPos(this, ranges[i].head));
        if (primary == null) primary = Math.min(ranges.length - 1, this.sel.primIndex);
        setSelection(this, normalizeSelection(out, primary), options);
      }),
      addSelection: docMethodOp(function(anchor, head, options) {
        var ranges = this.sel.ranges.slice(0);
        ranges.push(new Range(clipPos(this, anchor), clipPos(this, head || anchor)));
        setSelection(this, normalizeSelection(ranges, ranges.length - 1), options);
      }),
  
      getSelection: function(lineSep) {
        var ranges = this.sel.ranges, lines;
        for (var i = 0; i < ranges.length; i++) {
          var sel = getBetween(this, ranges[i].from(), ranges[i].to());
          lines = lines ? lines.concat(sel) : sel;
        }
        if (lineSep === false) return lines;
        else return lines.join(lineSep || this.lineSeparator());
      },
      getSelections: function(lineSep) {
        var parts = [], ranges = this.sel.ranges;
        for (var i = 0; i < ranges.length; i++) {
          var sel = getBetween(this, ranges[i].from(), ranges[i].to());
          if (lineSep !== false) sel = sel.join(lineSep || this.lineSeparator());
          parts[i] = sel;
        }
        return parts;
      },
      replaceSelection: function(code, collapse, origin) {
        var dup = [];
        for (var i = 0; i < this.sel.ranges.length; i++)
          dup[i] = code;
        this.replaceSelections(dup, collapse, origin || "+input");
      },
      replaceSelections: docMethodOp(function(code, collapse, origin) {
        var changes = [], sel = this.sel;
        for (var i = 0; i < sel.ranges.length; i++) {
          var range = sel.ranges[i];
          changes[i] = {from: range.from(), to: range.to(), text: this.splitLines(code[i]), origin: origin};
        }
        var newSel = collapse && collapse != "end" && computeReplacedSel(this, changes, collapse);
        for (var i = changes.length - 1; i >= 0; i--)
          makeChange(this, changes[i]);
        if (newSel) setSelectionReplaceHistory(this, newSel);
        else if (this.cm) ensureCursorVisible(this.cm);
      }),
      undo: docMethodOp(function() {makeChangeFromHistory(this, "undo");}),
      redo: docMethodOp(function() {makeChangeFromHistory(this, "redo");}),
      undoSelection: docMethodOp(function() {makeChangeFromHistory(this, "undo", true);}),
      redoSelection: docMethodOp(function() {makeChangeFromHistory(this, "redo", true);}),
  
      setExtending: function(val) {this.extend = val;},
      getExtending: function() {return this.extend;},
  
      historySize: function() {
        var hist = this.history, done = 0, undone = 0;
        for (var i = 0; i < hist.done.length; i++) if (!hist.done[i].ranges) ++done;
        for (var i = 0; i < hist.undone.length; i++) if (!hist.undone[i].ranges) ++undone;
        return {undo: done, redo: undone};
      },
      clearHistory: function() {this.history = new History(this.history.maxGeneration);},
  
      markClean: function() {
        this.cleanGeneration = this.changeGeneration(true);
      },
      changeGeneration: function(forceSplit) {
        if (forceSplit)
          this.history.lastOp = this.history.lastSelOp = this.history.lastOrigin = null;
        return this.history.generation;
      },
      isClean: function (gen) {
        return this.history.generation == (gen || this.cleanGeneration);
      },
  
      getHistory: function() {
        return {done: copyHistoryArray(this.history.done),
                undone: copyHistoryArray(this.history.undone)};
      },
      setHistory: function(histData) {
        var hist = this.history = new History(this.history.maxGeneration);
        hist.done = copyHistoryArray(histData.done.slice(0), null, true);
        hist.undone = copyHistoryArray(histData.undone.slice(0), null, true);
      },
  
      addLineClass: docMethodOp(function(handle, where, cls) {
        return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function(line) {
          var prop = where == "text" ? "textClass"
                   : where == "background" ? "bgClass"
                   : where == "gutter" ? "gutterClass" : "wrapClass";
          if (!line[prop]) line[prop] = cls;
          else if (classTest(cls).test(line[prop])) return false;
          else line[prop] += " " + cls;
          return true;
        });
      }),
      removeLineClass: docMethodOp(function(handle, where, cls) {
        return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function(line) {
          var prop = where == "text" ? "textClass"
                   : where == "background" ? "bgClass"
                   : where == "gutter" ? "gutterClass" : "wrapClass";
          var cur = line[prop];
          if (!cur) return false;
          else if (cls == null) line[prop] = null;
          else {
            var found = cur.match(classTest(cls));
            if (!found) return false;
            var end = found.index + found[0].length;
            line[prop] = cur.slice(0, found.index) + (!found.index || end == cur.length ? "" : " ") + cur.slice(end) || null;
          }
          return true;
        });
      }),
  
      addLineWidget: docMethodOp(function(handle, node, options) {
        return addLineWidget(this, handle, node, options);
      }),
      removeLineWidget: function(widget) { widget.clear(); },
  
      markText: function(from, to, options) {
        return markText(this, clipPos(this, from), clipPos(this, to), options, "range");
      },
      setBookmark: function(pos, options) {
        var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                        insertLeft: options && options.insertLeft,
                        clearWhenEmpty: false, shared: options && options.shared,
                        handleMouseEvents: options && options.handleMouseEvents};
        pos = clipPos(this, pos);
        return markText(this, pos, pos, realOpts, "bookmark");
      },
      findMarksAt: function(pos) {
        pos = clipPos(this, pos);
        var markers = [], spans = getLine(this, pos.line).markedSpans;
        if (spans) for (var i = 0; i < spans.length; ++i) {
          var span = spans[i];
          if ((span.from == null || span.from <= pos.ch) &&
              (span.to == null || span.to >= pos.ch))
            markers.push(span.marker.parent || span.marker);
        }
        return markers;
      },
      findMarks: function(from, to, filter) {
        from = clipPos(this, from); to = clipPos(this, to);
        var found = [], lineNo = from.line;
        this.iter(from.line, to.line + 1, function(line) {
          var spans = line.markedSpans;
          if (spans) for (var i = 0; i < spans.length; i++) {
            var span = spans[i];
            if (!(lineNo == from.line && from.ch > span.to ||
                  span.from == null && lineNo != from.line||
                  lineNo == to.line && span.from > to.ch) &&
                (!filter || filter(span.marker)))
              found.push(span.marker.parent || span.marker);
          }
          ++lineNo;
        });
        return found;
      },
      getAllMarks: function() {
        var markers = [];
        this.iter(function(line) {
          var sps = line.markedSpans;
          if (sps) for (var i = 0; i < sps.length; ++i)
            if (sps[i].from != null) markers.push(sps[i].marker);
        });
        return markers;
      },
  
      posFromIndex: function(off) {
        var ch, lineNo = this.first;
        this.iter(function(line) {
          var sz = line.text.length + 1;
          if (sz > off) { ch = off; return true; }
          off -= sz;
          ++lineNo;
        });
        return clipPos(this, Pos(lineNo, ch));
      },
      indexFromPos: function (coords) {
        coords = clipPos(this, coords);
        var index = coords.ch;
        if (coords.line < this.first || coords.ch < 0) return 0;
        this.iter(this.first, coords.line, function (line) {
          index += line.text.length + 1;
        });
        return index;
      },
  
      copy: function(copyHistory) {
        var doc = new Doc(getLines(this, this.first, this.first + this.size),
                          this.modeOption, this.first, this.lineSep);
        doc.scrollTop = this.scrollTop; doc.scrollLeft = this.scrollLeft;
        doc.sel = this.sel;
        doc.extend = false;
        if (copyHistory) {
          doc.history.undoDepth = this.history.undoDepth;
          doc.setHistory(this.getHistory());
        }
        return doc;
      },
  
      linkedDoc: function(options) {
        if (!options) options = {};
        var from = this.first, to = this.first + this.size;
        if (options.from != null && options.from > from) from = options.from;
        if (options.to != null && options.to < to) to = options.to;
        var copy = new Doc(getLines(this, from, to), options.mode || this.modeOption, from, this.lineSep);
        if (options.sharedHist) copy.history = this.history;
        (this.linked || (this.linked = [])).push({doc: copy, sharedHist: options.sharedHist});
        copy.linked = [{doc: this, isParent: true, sharedHist: options.sharedHist}];
        copySharedMarkers(copy, findSharedMarkers(this));
        return copy;
      },
      unlinkDoc: function(other) {
        if (other instanceof CodeMirror) other = other.doc;
        if (this.linked) for (var i = 0; i < this.linked.length; ++i) {
          var link = this.linked[i];
          if (link.doc != other) continue;
          this.linked.splice(i, 1);
          other.unlinkDoc(this);
          detachSharedMarkers(findSharedMarkers(this));
          break;
        }
        // If the histories were shared, split them again
        if (other.history == this.history) {
          var splitIds = [other.id];
          linkedDocs(other, function(doc) {splitIds.push(doc.id);}, true);
          other.history = new History(null);
          other.history.done = copyHistoryArray(this.history.done, splitIds);
          other.history.undone = copyHistoryArray(this.history.undone, splitIds);
        }
      },
      iterLinkedDocs: function(f) {linkedDocs(this, f);},
  
      getMode: function() {return this.mode;},
      getEditor: function() {return this.cm;},
  
      splitLines: function(str) {
        if (this.lineSep) return str.split(this.lineSep);
        return splitLinesAuto(str);
      },
      lineSeparator: function() { return this.lineSep || "\n"; }
    });
  
    // Public alias.
    Doc.prototype.eachLine = Doc.prototype.iter;
  
    // Set up methods on CodeMirror's prototype to redirect to the editor's document.
    var dontDelegate = "iter insert remove copy getEditor constructor".split(" ");
    for (var prop in Doc.prototype) if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
      CodeMirror.prototype[prop] = (function(method) {
        return function() {return method.apply(this.doc, arguments);};
      })(Doc.prototype[prop]);
  
    eventMixin(Doc);
  
    // Call f for all linked documents.
    function linkedDocs(doc, f, sharedHistOnly) {
      function propagate(doc, skip, sharedHist) {
        if (doc.linked) for (var i = 0; i < doc.linked.length; ++i) {
          var rel = doc.linked[i];
          if (rel.doc == skip) continue;
          var shared = sharedHist && rel.sharedHist;
          if (sharedHistOnly && !shared) continue;
          f(rel.doc, shared);
          propagate(rel.doc, doc, shared);
        }
      }
      propagate(doc, null, true);
    }
  
    // Attach a document to an editor.
    function attachDoc(cm, doc) {
      if (doc.cm) throw new Error("This document is already in use.");
      cm.doc = doc;
      doc.cm = cm;
      estimateLineHeights(cm);
      loadMode(cm);
      if (!cm.options.lineWrapping) findMaxLine(cm);
      cm.options.mode = doc.modeOption;
      regChange(cm);
    }
  
    // LINE UTILITIES
  
    // Find the line object corresponding to the given line number.
    function getLine(doc, n) {
      n -= doc.first;
      if (n < 0 || n >= doc.size) throw new Error("There is no line " + (n + doc.first) + " in the document.");
      for (var chunk = doc; !chunk.lines;) {
        for (var i = 0;; ++i) {
          var child = chunk.children[i], sz = child.chunkSize();
          if (n < sz) { chunk = child; break; }
          n -= sz;
        }
      }
      return chunk.lines[n];
    }
  
    // Get the part of a document between two positions, as an array of
    // strings.
    function getBetween(doc, start, end) {
      var out = [], n = start.line;
      doc.iter(start.line, end.line + 1, function(line) {
        var text = line.text;
        if (n == end.line) text = text.slice(0, end.ch);
        if (n == start.line) text = text.slice(start.ch);
        out.push(text);
        ++n;
      });
      return out;
    }
    // Get the lines between from and to, as array of strings.
    function getLines(doc, from, to) {
      var out = [];
      doc.iter(from, to, function(line) { out.push(line.text); });
      return out;
    }
  
    // Update the height of a line, propagating the height change
    // upwards to parent nodes.
    function updateLineHeight(line, height) {
      var diff = height - line.height;
      if (diff) for (var n = line; n; n = n.parent) n.height += diff;
    }
  
    // Given a line object, find its line number by walking up through
    // its parent links.
    function lineNo(line) {
      if (line.parent == null) return null;
      var cur = line.parent, no = indexOf(cur.lines, line);
      for (var chunk = cur.parent; chunk; cur = chunk, chunk = chunk.parent) {
        for (var i = 0;; ++i) {
          if (chunk.children[i] == cur) break;
          no += chunk.children[i].chunkSize();
        }
      }
      return no + cur.first;
    }
  
    // Find the line at the given vertical position, using the height
    // information in the document tree.
    function lineAtHeight(chunk, h) {
      var n = chunk.first;
      outer: do {
        for (var i = 0; i < chunk.children.length; ++i) {
          var child = chunk.children[i], ch = child.height;
          if (h < ch) { chunk = child; continue outer; }
          h -= ch;
          n += child.chunkSize();
        }
        return n;
      } while (!chunk.lines);
      for (var i = 0; i < chunk.lines.length; ++i) {
        var line = chunk.lines[i], lh = line.height;
        if (h < lh) break;
        h -= lh;
      }
      return n + i;
    }
  
  
    // Find the height above the given line.
    function heightAtLine(lineObj) {
      lineObj = visualLine(lineObj);
  
      var h = 0, chunk = lineObj.parent;
      for (var i = 0; i < chunk.lines.length; ++i) {
        var line = chunk.lines[i];
        if (line == lineObj) break;
        else h += line.height;
      }
      for (var p = chunk.parent; p; chunk = p, p = chunk.parent) {
        for (var i = 0; i < p.children.length; ++i) {
          var cur = p.children[i];
          if (cur == chunk) break;
          else h += cur.height;
        }
      }
      return h;
    }
  
    // Get the bidi ordering for the given line (and cache it). Returns
    // false for lines that are fully left-to-right, and an array of
    // BidiSpan objects otherwise.
    function getOrder(line) {
      var order = line.order;
      if (order == null) order = line.order = bidiOrdering(line.text);
      return order;
    }
  
    // HISTORY
  
    function History(startGen) {
      // Arrays of change events and selections. Doing something adds an
      // event to done and clears undo. Undoing moves events from done
      // to undone, redoing moves them in the other direction.
      this.done = []; this.undone = [];
      this.undoDepth = Infinity;
      // Used to track when changes can be merged into a single undo
      // event
      this.lastModTime = this.lastSelTime = 0;
      this.lastOp = this.lastSelOp = null;
      this.lastOrigin = this.lastSelOrigin = null;
      // Used by the isClean() method
      this.generation = this.maxGeneration = startGen || 1;
    }
  
    // Create a history change event from an updateDoc-style change
    // object.
    function historyChangeFromChange(doc, change) {
      var histChange = {from: copyPos(change.from), to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
      attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
      linkedDocs(doc, function(doc) {attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);}, true);
      return histChange;
    }
  
    // Pop all selection events off the end of a history array. Stop at
    // a change event.
    function clearSelectionEvents(array) {
      while (array.length) {
        var last = lst(array);
        if (last.ranges) array.pop();
        else break;
      }
    }
  
    // Find the top change event in the history. Pop off selection
    // events that are in the way.
    function lastChangeEvent(hist, force) {
      if (force) {
        clearSelectionEvents(hist.done);
        return lst(hist.done);
      } else if (hist.done.length && !lst(hist.done).ranges) {
        return lst(hist.done);
      } else if (hist.done.length > 1 && !hist.done[hist.done.length - 2].ranges) {
        hist.done.pop();
        return lst(hist.done);
      }
    }
  
    // Register a change in the history. Merges changes that are within
    // a single operation, ore are close together with an origin that
    // allows merging (starting with "+") into a single event.
    function addChangeToHistory(doc, change, selAfter, opId) {
      var hist = doc.history;
      hist.undone.length = 0;
      var time = +new Date, cur;
  
      if ((hist.lastOp == opId ||
           hist.lastOrigin == change.origin && change.origin &&
           ((change.origin.charAt(0) == "+" && doc.cm && hist.lastModTime > time - doc.cm.options.historyEventDelay) ||
            change.origin.charAt(0) == "*")) &&
          (cur = lastChangeEvent(hist, hist.lastOp == opId))) {
        // Merge this change into the last event
        var last = lst(cur.changes);
        if (cmp(change.from, change.to) == 0 && cmp(change.from, last.to) == 0) {
          // Optimized case for simple insertion -- don't want to add
          // new changesets for every character typed
          last.to = changeEnd(change);
        } else {
          // Add new sub-event
          cur.changes.push(historyChangeFromChange(doc, change));
        }
      } else {
        // Can not be merged, start a new event.
        var before = lst(hist.done);
        if (!before || !before.ranges)
          pushSelectionToHistory(doc.sel, hist.done);
        cur = {changes: [historyChangeFromChange(doc, change)],
               generation: hist.generation};
        hist.done.push(cur);
        while (hist.done.length > hist.undoDepth) {
          hist.done.shift();
          if (!hist.done[0].ranges) hist.done.shift();
        }
      }
      hist.done.push(selAfter);
      hist.generation = ++hist.maxGeneration;
      hist.lastModTime = hist.lastSelTime = time;
      hist.lastOp = hist.lastSelOp = opId;
      hist.lastOrigin = hist.lastSelOrigin = change.origin;
  
      if (!last) signal(doc, "historyAdded");
    }
  
    function selectionEventCanBeMerged(doc, origin, prev, sel) {
      var ch = origin.charAt(0);
      return ch == "*" ||
        ch == "+" &&
        prev.ranges.length == sel.ranges.length &&
        prev.somethingSelected() == sel.somethingSelected() &&
        new Date - doc.history.lastSelTime <= (doc.cm ? doc.cm.options.historyEventDelay : 500);
    }
  
    // Called whenever the selection changes, sets the new selection as
    // the pending selection in the history, and pushes the old pending
    // selection into the 'done' array when it was significantly
    // different (in number of selected ranges, emptiness, or time).
    function addSelectionToHistory(doc, sel, opId, options) {
      var hist = doc.history, origin = options && options.origin;
  
      // A new event is started when the previous origin does not match
      // the current, or the origins don't allow matching. Origins
      // starting with * are always merged, those starting with + are
      // merged when similar and close together in time.
      if (opId == hist.lastSelOp ||
          (origin && hist.lastSelOrigin == origin &&
           (hist.lastModTime == hist.lastSelTime && hist.lastOrigin == origin ||
            selectionEventCanBeMerged(doc, origin, lst(hist.done), sel))))
        hist.done[hist.done.length - 1] = sel;
      else
        pushSelectionToHistory(sel, hist.done);
  
      hist.lastSelTime = +new Date;
      hist.lastSelOrigin = origin;
      hist.lastSelOp = opId;
      if (options && options.clearRedo !== false)
        clearSelectionEvents(hist.undone);
    }
  
    function pushSelectionToHistory(sel, dest) {
      var top = lst(dest);
      if (!(top && top.ranges && top.equals(sel)))
        dest.push(sel);
    }
  
    // Used to store marked span information in the history.
    function attachLocalSpans(doc, change, from, to) {
      var existing = change["spans_" + doc.id], n = 0;
      doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function(line) {
        if (line.markedSpans)
          (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans;
        ++n;
      });
    }
  
    // When un/re-doing restores text containing marked spans, those
    // that have been explicitly cleared should not be restored.
    function removeClearedSpans(spans) {
      if (!spans) return null;
      for (var i = 0, out; i < spans.length; ++i) {
        if (spans[i].marker.explicitlyCleared) { if (!out) out = spans.slice(0, i); }
        else if (out) out.push(spans[i]);
      }
      return !out ? spans : out.length ? out : null;
    }
  
    // Retrieve and filter the old marked spans stored in a change event.
    function getOldSpans(doc, change) {
      var found = change["spans_" + doc.id];
      if (!found) return null;
      for (var i = 0, nw = []; i < change.text.length; ++i)
        nw.push(removeClearedSpans(found[i]));
      return nw;
    }
  
    // Used both to provide a JSON-safe object in .getHistory, and, when
    // detaching a document, to split the history in two
    function copyHistoryArray(events, newGroup, instantiateSel) {
      for (var i = 0, copy = []; i < events.length; ++i) {
        var event = events[i];
        if (event.ranges) {
          copy.push(instantiateSel ? Selection.prototype.deepCopy.call(event) : event);
          continue;
        }
        var changes = event.changes, newChanges = [];
        copy.push({changes: newChanges});
        for (var j = 0; j < changes.length; ++j) {
          var change = changes[j], m;
          newChanges.push({from: change.from, to: change.to, text: change.text});
          if (newGroup) for (var prop in change) if (m = prop.match(/^spans_(\d+)$/)) {
            if (indexOf(newGroup, Number(m[1])) > -1) {
              lst(newChanges)[prop] = change[prop];
              delete change[prop];
            }
          }
        }
      }
      return copy;
    }
  
    // Rebasing/resetting history to deal with externally-sourced changes
  
    function rebaseHistSelSingle(pos, from, to, diff) {
      if (to < pos.line) {
        pos.line += diff;
      } else if (from < pos.line) {
        pos.line = from;
        pos.ch = 0;
      }
    }
  
    // Tries to rebase an array of history events given a change in the
    // document. If the change touches the same lines as the event, the
    // event, and everything 'behind' it, is discarded. If the change is
    // before the event, the event's positions are updated. Uses a
    // copy-on-write scheme for the positions, to avoid having to
    // reallocate them all on every rebase, but also avoid problems with
    // shared position objects being unsafely updated.
    function rebaseHistArray(array, from, to, diff) {
      for (var i = 0; i < array.length; ++i) {
        var sub = array[i], ok = true;
        if (sub.ranges) {
          if (!sub.copied) { sub = array[i] = sub.deepCopy(); sub.copied = true; }
          for (var j = 0; j < sub.ranges.length; j++) {
            rebaseHistSelSingle(sub.ranges[j].anchor, from, to, diff);
            rebaseHistSelSingle(sub.ranges[j].head, from, to, diff);
          }
          continue;
        }
        for (var j = 0; j < sub.changes.length; ++j) {
          var cur = sub.changes[j];
          if (to < cur.from.line) {
            cur.from = Pos(cur.from.line + diff, cur.from.ch);
            cur.to = Pos(cur.to.line + diff, cur.to.ch);
          } else if (from <= cur.to.line) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          array.splice(0, i + 1);
          i = 0;
        }
      }
    }
  
    function rebaseHist(hist, change) {
      var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
      rebaseHistArray(hist.done, from, to, diff);
      rebaseHistArray(hist.undone, from, to, diff);
    }
  
    // EVENT UTILITIES
  
    // Due to the fact that we still support jurassic IE versions, some
    // compatibility wrappers are needed.
  
    var e_preventDefault = CodeMirror.e_preventDefault = function(e) {
      if (e.preventDefault) e.preventDefault();
      else e.returnValue = false;
    };
    var e_stopPropagation = CodeMirror.e_stopPropagation = function(e) {
      if (e.stopPropagation) e.stopPropagation();
      else e.cancelBubble = true;
    };
    function e_defaultPrevented(e) {
      return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false;
    }
    var e_stop = CodeMirror.e_stop = function(e) {e_preventDefault(e); e_stopPropagation(e);};
  
    function e_target(e) {return e.target || e.srcElement;}
    function e_button(e) {
      var b = e.which;
      if (b == null) {
        if (e.button & 1) b = 1;
        else if (e.button & 2) b = 3;
        else if (e.button & 4) b = 2;
      }
      if (mac && e.ctrlKey && b == 1) b = 3;
      return b;
    }
  
    // EVENT HANDLING
  
    // Lightweight event framework. on/off also work on DOM nodes,
    // registering native DOM handlers.
  
    var on = CodeMirror.on = function(emitter, type, f) {
      if (emitter.addEventListener)
        emitter.addEventListener(type, f, false);
      else if (emitter.attachEvent)
        emitter.attachEvent("on" + type, f);
      else {
        var map = emitter._handlers || (emitter._handlers = {});
        var arr = map[type] || (map[type] = []);
        arr.push(f);
      }
    };
  
    var off = CodeMirror.off = function(emitter, type, f) {
      if (emitter.removeEventListener)
        emitter.removeEventListener(type, f, false);
      else if (emitter.detachEvent)
        emitter.detachEvent("on" + type, f);
      else {
        var arr = emitter._handlers && emitter._handlers[type];
        if (!arr) return;
        for (var i = 0; i < arr.length; ++i)
          if (arr[i] == f) { arr.splice(i, 1); break; }
      }
    };
  
    var signal = CodeMirror.signal = function(emitter, type /*, values...*/) {
      var arr = emitter._handlers && emitter._handlers[type];
      if (!arr) return;
      var args = Array.prototype.slice.call(arguments, 2);
      for (var i = 0; i < arr.length; ++i) arr[i].apply(null, args);
    };
  
    var orphanDelayedCallbacks = null;
  
    // Often, we want to signal events at a point where we are in the
    // middle of some work, but don't want the handler to start calling
    // other methods on the editor, which might be in an inconsistent
    // state or simply not expect any other events to happen.
    // signalLater looks whether there are any handlers, and schedules
    // them to be executed when the last operation ends, or, if no
    // operation is active, when a timeout fires.
    function signalLater(emitter, type /*, values...*/) {
      var arr = emitter._handlers && emitter._handlers[type];
      if (!arr) return;
      var args = Array.prototype.slice.call(arguments, 2), list;
      if (operationGroup) {
        list = operationGroup.delayedCallbacks;
      } else if (orphanDelayedCallbacks) {
        list = orphanDelayedCallbacks;
      } else {
        list = orphanDelayedCallbacks = [];
        setTimeout(fireOrphanDelayed, 0);
      }
      function bnd(f) {return function(){f.apply(null, args);};};
      for (var i = 0; i < arr.length; ++i)
        list.push(bnd(arr[i]));
    }
  
    function fireOrphanDelayed() {
      var delayed = orphanDelayedCallbacks;
      orphanDelayedCallbacks = null;
      for (var i = 0; i < delayed.length; ++i) delayed[i]();
    }
  
    // The DOM events that CodeMirror handles can be overridden by
    // registering a (non-DOM) handler on the editor for the event name,
    // and preventDefault-ing the event in that handler.
    function signalDOMEvent(cm, e, override) {
      if (typeof e == "string")
        e = {type: e, preventDefault: function() { this.defaultPrevented = true; }};
      signal(cm, override || e.type, cm, e);
      return e_defaultPrevented(e) || e.codemirrorIgnore;
    }
  
    function signalCursorActivity(cm) {
      var arr = cm._handlers && cm._handlers.cursorActivity;
      if (!arr) return;
      var set = cm.curOp.cursorActivityHandlers || (cm.curOp.cursorActivityHandlers = []);
      for (var i = 0; i < arr.length; ++i) if (indexOf(set, arr[i]) == -1)
        set.push(arr[i]);
    }
  
    function hasHandler(emitter, type) {
      var arr = emitter._handlers && emitter._handlers[type];
      return arr && arr.length > 0;
    }
  
    // Add on and off methods to a constructor's prototype, to make
    // registering events on such objects more convenient.
    function eventMixin(ctor) {
      ctor.prototype.on = function(type, f) {on(this, type, f);};
      ctor.prototype.off = function(type, f) {off(this, type, f);};
    }
  
    // MISC UTILITIES
  
    // Number of pixels added to scroller and sizer to hide scrollbar
    var scrollerGap = 30;
  
    // Returned or thrown by various protocols to signal 'I'm not
    // handling this'.
    var Pass = CodeMirror.Pass = {toString: function(){return "CodeMirror.Pass";}};
  
    // Reused option objects for setSelection & friends
    var sel_dontScroll = {scroll: false}, sel_mouse = {origin: "*mouse"}, sel_move = {origin: "+move"};
  
    function Delayed() {this.id = null;}
    Delayed.prototype.set = function(ms, f) {
      clearTimeout(this.id);
      this.id = setTimeout(f, ms);
    };
  
    // Counts the column offset in a string, taking tabs into account.
    // Used mostly to find indentation.
    var countColumn = CodeMirror.countColumn = function(string, end, tabSize, startIndex, startValue) {
      if (end == null) {
        end = string.search(/[^\s\u00a0]/);
        if (end == -1) end = string.length;
      }
      for (var i = startIndex || 0, n = startValue || 0;;) {
        var nextTab = string.indexOf("\t", i);
        if (nextTab < 0 || nextTab >= end)
          return n + (end - i);
        n += nextTab - i;
        n += tabSize - (n % tabSize);
        i = nextTab + 1;
      }
    };
  
    // The inverse of countColumn -- find the offset that corresponds to
    // a particular column.
    function findColumn(string, goal, tabSize) {
      for (var pos = 0, col = 0;;) {
        var nextTab = string.indexOf("\t", pos);
        if (nextTab == -1) nextTab = string.length;
        var skipped = nextTab - pos;
        if (nextTab == string.length || col + skipped >= goal)
          return pos + Math.min(skipped, goal - col);
        col += nextTab - pos;
        col += tabSize - (col % tabSize);
        pos = nextTab + 1;
        if (col >= goal) return pos;
      }
    }
  
    var spaceStrs = [""];
    function spaceStr(n) {
      while (spaceStrs.length <= n)
        spaceStrs.push(lst(spaceStrs) + " ");
      return spaceStrs[n];
    }
  
    function lst(arr) { return arr[arr.length-1]; }
  
    var selectInput = function(node) { node.select(); };
    if (ios) // Mobile Safari apparently has a bug where select() is broken.
      selectInput = function(node) { node.selectionStart = 0; node.selectionEnd = node.value.length; };
    else if (ie) // Suppress mysterious IE10 errors
      selectInput = function(node) { try { node.select(); } catch(_e) {} };
  
    function indexOf(array, elt) {
      for (var i = 0; i < array.length; ++i)
        if (array[i] == elt) return i;
      return -1;
    }
    function map(array, f) {
      var out = [];
      for (var i = 0; i < array.length; i++) out[i] = f(array[i], i);
      return out;
    }
  
    function nothing() {}
  
    function createObj(base, props) {
      var inst;
      if (Object.create) {
        inst = Object.create(base);
      } else {
        nothing.prototype = base;
        inst = new nothing();
      }
      if (props) copyObj(props, inst);
      return inst;
    };
  
    function copyObj(obj, target, overwrite) {
      if (!target) target = {};
      for (var prop in obj)
        if (obj.hasOwnProperty(prop) && (overwrite !== false || !target.hasOwnProperty(prop)))
          target[prop] = obj[prop];
      return target;
    }
  
    function bind(f) {
      var args = Array.prototype.slice.call(arguments, 1);
      return function(){return f.apply(null, args);};
    }
  
    var nonASCIISingleCaseWordChar = /[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
    var isWordCharBasic = CodeMirror.isWordChar = function(ch) {
      return /\w/.test(ch) || ch > "\x80" &&
        (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch));
    };
    function isWordChar(ch, helper) {
      if (!helper) return isWordCharBasic(ch);
      if (helper.source.indexOf("\\w") > -1 && isWordCharBasic(ch)) return true;
      return helper.test(ch);
    }
  
    function isEmpty(obj) {
      for (var n in obj) if (obj.hasOwnProperty(n) && obj[n]) return false;
      return true;
    }
  
    // Extending unicode characters. A series of a non-extending char +
    // any number of extending chars is treated as a single unit as far
    // as editing and measuring is concerned. This is not fully correct,
    // since some scripts/fonts/browsers also treat other configurations
    // of code points as a group.
    var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
    function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch); }
  
    // DOM UTILITIES
  
    function elt(tag, content, className, style) {
      var e = document.createElement(tag);
      if (className) e.className = className;
      if (style) e.style.cssText = style;
      if (typeof content == "string") e.appendChild(document.createTextNode(content));
      else if (content) for (var i = 0; i < content.length; ++i) e.appendChild(content[i]);
      return e;
    }
  
    var range;
    if (document.createRange) range = function(node, start, end, endNode) {
      var r = document.createRange();
      r.setEnd(endNode || node, end);
      r.setStart(node, start);
      return r;
    };
    else range = function(node, start, end) {
      var r = document.body.createTextRange();
      try { r.moveToElementText(node.parentNode); }
      catch(e) { return r; }
      r.collapse(true);
      r.moveEnd("character", end);
      r.moveStart("character", start);
      return r;
    };
  
    function removeChildren(e) {
      for (var count = e.childNodes.length; count > 0; --count)
        e.removeChild(e.firstChild);
      return e;
    }
  
    function removeChildrenAndAdd(parent, e) {
      return removeChildren(parent).appendChild(e);
    }
  
    var contains = CodeMirror.contains = function(parent, child) {
      if (child.nodeType == 3) // Android browser always returns false when child is a textnode
        child = child.parentNode;
      if (parent.contains)
        return parent.contains(child);
      do {
        if (child.nodeType == 11) child = child.host;
        if (child == parent) return true;
      } while (child = child.parentNode);
    };
  
    function activeElt() {
      var activeElement = document.activeElement;
      while (activeElement && activeElement.root && activeElement.root.activeElement)
        activeElement = activeElement.root.activeElement;
      return activeElement;
    }
    // Older versions of IE throws unspecified error when touching
    // document.activeElement in some cases (during loading, in iframe)
    if (ie && ie_version < 11) activeElt = function() {
      try { return document.activeElement; }
      catch(e) { return document.body; }
    };
  
    function classTest(cls) { return new RegExp("(^|\\s)" + cls + "(?:$|\\s)\\s*"); }
    var rmClass = CodeMirror.rmClass = function(node, cls) {
      var current = node.className;
      var match = classTest(cls).exec(current);
      if (match) {
        var after = current.slice(match.index + match[0].length);
        node.className = current.slice(0, match.index) + (after ? match[1] + after : "");
      }
    };
    var addClass = CodeMirror.addClass = function(node, cls) {
      var current = node.className;
      if (!classTest(cls).test(current)) node.className += (current ? " " : "") + cls;
    };
    function joinClasses(a, b) {
      var as = a.split(" ");
      for (var i = 0; i < as.length; i++)
        if (as[i] && !classTest(as[i]).test(b)) b += " " + as[i];
      return b;
    }
  
    // WINDOW-WIDE EVENTS
  
    // These must be handled carefully, because naively registering a
    // handler for each editor will cause the editors to never be
    // garbage collected.
  
    function forEachCodeMirror(f) {
      if (!document.body.getElementsByClassName) return;
      var byClass = document.body.getElementsByClassName("CodeMirror");
      for (var i = 0; i < byClass.length; i++) {
        var cm = byClass[i].CodeMirror;
        if (cm) f(cm);
      }
    }
  
    var globalsRegistered = false;
    function ensureGlobalHandlers() {
      if (globalsRegistered) return;
      registerGlobalHandlers();
      globalsRegistered = true;
    }
    function registerGlobalHandlers() {
      // When the window resizes, we need to refresh active editors.
      var resizeTimer;
      on(window, "resize", function() {
        if (resizeTimer == null) resizeTimer = setTimeout(function() {
          resizeTimer = null;
          forEachCodeMirror(onResize);
        }, 100);
      });
      // When the window loses focus, we want to show the editor as blurred
      on(window, "blur", function() {
        forEachCodeMirror(onBlur);
      });
    }
  
    // FEATURE DETECTION
  
    // Detect drag-and-drop
    var dragAndDrop = function() {
      // There is *some* kind of drag-and-drop support in IE6-8, but I
      // couldn't get it to work yet.
      if (ie && ie_version < 9) return false;
      var div = elt('div');
      return "draggable" in div || "dragDrop" in div;
    }();
  
    var zwspSupported;
    function zeroWidthElement(measure) {
      if (zwspSupported == null) {
        var test = elt("span", "\u200b");
        removeChildrenAndAdd(measure, elt("span", [test, document.createTextNode("x")]));
        if (measure.firstChild.offsetHeight != 0)
          zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !(ie && ie_version < 8);
      }
      var node = zwspSupported ? elt("span", "\u200b") :
        elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
      node.setAttribute("cm-text", "");
      return node;
    }
  
    // Feature-detect IE's crummy client rect reporting for bidi text
    var badBidiRects;
    function hasBadBidiRects(measure) {
      if (badBidiRects != null) return badBidiRects;
      var txt = removeChildrenAndAdd(measure, document.createTextNode("A\u062eA"));
      var r0 = range(txt, 0, 1).getBoundingClientRect();
      if (!r0 || r0.left == r0.right) return false; // Safari returns null in some cases (#2780)
      var r1 = range(txt, 1, 2).getBoundingClientRect();
      return badBidiRects = (r1.right - r0.right < 3);
    }
  
    // See if "".split is the broken IE version, if so, provide an
    // alternative way to split lines.
    var splitLinesAuto = CodeMirror.splitLines = "\n\nb".split(/\n/).length != 3 ? function(string) {
      var pos = 0, result = [], l = string.length;
      while (pos <= l) {
        var nl = string.indexOf("\n", pos);
        if (nl == -1) nl = string.length;
        var line = string.slice(pos, string.charAt(nl - 1) == "\r" ? nl - 1 : nl);
        var rt = line.indexOf("\r");
        if (rt != -1) {
          result.push(line.slice(0, rt));
          pos += rt + 1;
        } else {
          result.push(line);
          pos = nl + 1;
        }
      }
      return result;
    } : function(string){return string.split(/\r\n?|\n/);};
  
    var hasSelection = window.getSelection ? function(te) {
      try { return te.selectionStart != te.selectionEnd; }
      catch(e) { return false; }
    } : function(te) {
      try {var range = te.ownerDocument.selection.createRange();}
      catch(e) {}
      if (!range || range.parentElement() != te) return false;
      return range.compareEndPoints("StartToEnd", range) != 0;
    };
  
    var hasCopyEvent = (function() {
      var e = elt("div");
      if ("oncopy" in e) return true;
      e.setAttribute("oncopy", "return;");
      return typeof e.oncopy == "function";
    })();
  
    var badZoomedRects = null;
    function hasBadZoomedRects(measure) {
      if (badZoomedRects != null) return badZoomedRects;
      var node = removeChildrenAndAdd(measure, elt("span", "x"));
      var normal = node.getBoundingClientRect();
      var fromRange = range(node, 0, 1).getBoundingClientRect();
      return badZoomedRects = Math.abs(normal.left - fromRange.left) > 1;
    }
  
    // KEY NAMES
  
    var keyNames = {3: "Enter", 8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt",
                    19: "Pause", 20: "CapsLock", 27: "Esc", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End",
                    36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 44: "PrintScrn", 45: "Insert",
                    46: "Delete", 59: ";", 61: "=", 91: "Mod", 92: "Mod", 93: "Mod", 107: "=", 109: "-", 127: "Delete",
                    173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\",
                    221: "]", 222: "'", 63232: "Up", 63233: "Down", 63234: "Left", 63235: "Right", 63272: "Delete",
                    63273: "Home", 63275: "End", 63276: "PageUp", 63277: "PageDown", 63302: "Insert"};
    CodeMirror.keyNames = keyNames;
    (function() {
      // Number keys
      for (var i = 0; i < 10; i++) keyNames[i + 48] = keyNames[i + 96] = String(i);
      // Alphabetic keys
      for (var i = 65; i <= 90; i++) keyNames[i] = String.fromCharCode(i);
      // Function keys
      for (var i = 1; i <= 12; i++) keyNames[i + 111] = keyNames[i + 63235] = "F" + i;
    })();
  
    // BIDI HELPERS
  
    function iterateBidiSections(order, from, to, f) {
      if (!order) return f(from, to, "ltr");
      var found = false;
      for (var i = 0; i < order.length; ++i) {
        var part = order[i];
        if (part.from < to && part.to > from || from == to && part.to == from) {
          f(Math.max(part.from, from), Math.min(part.to, to), part.level == 1 ? "rtl" : "ltr");
          found = true;
        }
      }
      if (!found) f(from, to, "ltr");
    }
  
    function bidiLeft(part) { return part.level % 2 ? part.to : part.from; }
    function bidiRight(part) { return part.level % 2 ? part.from : part.to; }
  
    function lineLeft(line) { var order = getOrder(line); return order ? bidiLeft(order[0]) : 0; }
    function lineRight(line) {
      var order = getOrder(line);
      if (!order) return line.text.length;
      return bidiRight(lst(order));
    }
  
    function lineStart(cm, lineN) {
      var line = getLine(cm.doc, lineN);
      var visual = visualLine(line);
      if (visual != line) lineN = lineNo(visual);
      var order = getOrder(visual);
      var ch = !order ? 0 : order[0].level % 2 ? lineRight(visual) : lineLeft(visual);
      return Pos(lineN, ch);
    }
    function lineEnd(cm, lineN) {
      var merged, line = getLine(cm.doc, lineN);
      while (merged = collapsedSpanAtEnd(line)) {
        line = merged.find(1, true).line;
        lineN = null;
      }
      var order = getOrder(line);
      var ch = !order ? line.text.length : order[0].level % 2 ? lineLeft(line) : lineRight(line);
      return Pos(lineN == null ? lineNo(line) : lineN, ch);
    }
    function lineStartSmart(cm, pos) {
      var start = lineStart(cm, pos.line);
      var line = getLine(cm.doc, start.line);
      var order = getOrder(line);
      if (!order || order[0].level == 0) {
        var firstNonWS = Math.max(0, line.text.search(/\S/));
        var inWS = pos.line == start.line && pos.ch <= firstNonWS && pos.ch;
        return Pos(start.line, inWS ? 0 : firstNonWS);
      }
      return start;
    }
  
    function compareBidiLevel(order, a, b) {
      var linedir = order[0].level;
      if (a == linedir) return true;
      if (b == linedir) return false;
      return a < b;
    }
    var bidiOther;
    function getBidiPartAt(order, pos) {
      bidiOther = null;
      for (var i = 0, found; i < order.length; ++i) {
        var cur = order[i];
        if (cur.from < pos && cur.to > pos) return i;
        if ((cur.from == pos || cur.to == pos)) {
          if (found == null) {
            found = i;
          } else if (compareBidiLevel(order, cur.level, order[found].level)) {
            if (cur.from != cur.to) bidiOther = found;
            return i;
          } else {
            if (cur.from != cur.to) bidiOther = i;
            return found;
          }
        }
      }
      return found;
    }
  
    function moveInLine(line, pos, dir, byUnit) {
      if (!byUnit) return pos + dir;
      do pos += dir;
      while (pos > 0 && isExtendingChar(line.text.charAt(pos)));
      return pos;
    }
  
    // This is needed in order to move 'visually' through bi-directional
    // text -- i.e., pressing left should make the cursor go left, even
    // when in RTL text. The tricky part is the 'jumps', where RTL and
    // LTR text touch each other. This often requires the cursor offset
    // to move more than one unit, in order to visually move one unit.
    function moveVisually(line, start, dir, byUnit) {
      var bidi = getOrder(line);
      if (!bidi) return moveLogically(line, start, dir, byUnit);
      var pos = getBidiPartAt(bidi, start), part = bidi[pos];
      var target = moveInLine(line, start, part.level % 2 ? -dir : dir, byUnit);
  
      for (;;) {
        if (target > part.from && target < part.to) return target;
        if (target == part.from || target == part.to) {
          if (getBidiPartAt(bidi, target) == pos) return target;
          part = bidi[pos += dir];
          return (dir > 0) == part.level % 2 ? part.to : part.from;
        } else {
          part = bidi[pos += dir];
          if (!part) return null;
          if ((dir > 0) == part.level % 2)
            target = moveInLine(line, part.to, -1, byUnit);
          else
            target = moveInLine(line, part.from, 1, byUnit);
        }
      }
    }
  
    function moveLogically(line, start, dir, byUnit) {
      var target = start + dir;
      if (byUnit) while (target > 0 && isExtendingChar(line.text.charAt(target))) target += dir;
      return target < 0 || target > line.text.length ? null : target;
    }
  
    // Bidirectional ordering algorithm
    // See http://unicode.org/reports/tr9/tr9-13.html for the algorithm
    // that this (partially) implements.
  
    // One-char codes used for character types:
    // L (L):   Left-to-Right
    // R (R):   Right-to-Left
    // r (AL):  Right-to-Left Arabic
    // 1 (EN):  European Number
    // + (ES):  European Number Separator
    // % (ET):  European Number Terminator
    // n (AN):  Arabic Number
    // , (CS):  Common Number Separator
    // m (NSM): Non-Spacing Mark
    // b (BN):  Boundary Neutral
    // s (B):   Paragraph Separator
    // t (S):   Segment Separator
    // w (WS):  Whitespace
    // N (ON):  Other Neutrals
  
    // Returns null if characters are ordered as they appear
    // (left-to-right), or an array of sections ({from, to, level}
    // objects) in the order in which they occur visually.
    var bidiOrdering = (function() {
      // Character types for codepoints 0 to 0xff
      var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN";
      // Character types for codepoints 0x600 to 0x6ff
      var arabicTypes = "rrrrrrrrrrrr,rNNmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmrrrrrrrnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmNmmmm";
      function charType(code) {
        if (code <= 0xf7) return lowTypes.charAt(code);
        else if (0x590 <= code && code <= 0x5f4) return "R";
        else if (0x600 <= code && code <= 0x6ed) return arabicTypes.charAt(code - 0x600);
        else if (0x6ee <= code && code <= 0x8ac) return "r";
        else if (0x2000 <= code && code <= 0x200b) return "w";
        else if (code == 0x200c) return "b";
        else return "L";
      }
  
      var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
      var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
      // Browsers seem to always treat the boundaries of block elements as being L.
      var outerType = "L";
  
      function BidiSpan(level, from, to) {
        this.level = level;
        this.from = from; this.to = to;
      }
  
      return function(str) {
        if (!bidiRE.test(str)) return false;
        var len = str.length, types = [];
        for (var i = 0, type; i < len; ++i)
          types.push(type = charType(str.charCodeAt(i)));
  
        // W1. Examine each non-spacing mark (NSM) in the level run, and
        // change the type of the NSM to the type of the previous
        // character. If the NSM is at the start of the level run, it will
        // get the type of sor.
        for (var i = 0, prev = outerType; i < len; ++i) {
          var type = types[i];
          if (type == "m") types[i] = prev;
          else prev = type;
        }
  
        // W2. Search backwards from each instance of a European number
        // until the first strong type (R, L, AL, or sor) is found. If an
        // AL is found, change the type of the European number to Arabic
        // number.
        // W3. Change all ALs to R.
        for (var i = 0, cur = outerType; i < len; ++i) {
          var type = types[i];
          if (type == "1" && cur == "r") types[i] = "n";
          else if (isStrong.test(type)) { cur = type; if (type == "r") types[i] = "R"; }
        }
  
        // W4. A single European separator between two European numbers
        // changes to a European number. A single common separator between
        // two numbers of the same type changes to that type.
        for (var i = 1, prev = types[0]; i < len - 1; ++i) {
          var type = types[i];
          if (type == "+" && prev == "1" && types[i+1] == "1") types[i] = "1";
          else if (type == "," && prev == types[i+1] &&
                   (prev == "1" || prev == "n")) types[i] = prev;
          prev = type;
        }
  
        // W5. A sequence of European terminators adjacent to European
        // numbers changes to all European numbers.
        // W6. Otherwise, separators and terminators change to Other
        // Neutral.
        for (var i = 0; i < len; ++i) {
          var type = types[i];
          if (type == ",") types[i] = "N";
          else if (type == "%") {
            for (var end = i + 1; end < len && types[end] == "%"; ++end) {}
            var replace = (i && types[i-1] == "!") || (end < len && types[end] == "1") ? "1" : "N";
            for (var j = i; j < end; ++j) types[j] = replace;
            i = end - 1;
          }
        }
  
        // W7. Search backwards from each instance of a European number
        // until the first strong type (R, L, or sor) is found. If an L is
        // found, then change the type of the European number to L.
        for (var i = 0, cur = outerType; i < len; ++i) {
          var type = types[i];
          if (cur == "L" && type == "1") types[i] = "L";
          else if (isStrong.test(type)) cur = type;
        }
  
        // N1. A sequence of neutrals takes the direction of the
        // surrounding strong text if the text on both sides has the same
        // direction. European and Arabic numbers act as if they were R in
        // terms of their influence on neutrals. Start-of-level-run (sor)
        // and end-of-level-run (eor) are used at level run boundaries.
        // N2. Any remaining neutrals take the embedding direction.
        for (var i = 0; i < len; ++i) {
          if (isNeutral.test(types[i])) {
            for (var end = i + 1; end < len && isNeutral.test(types[end]); ++end) {}
            var before = (i ? types[i-1] : outerType) == "L";
            var after = (end < len ? types[end] : outerType) == "L";
            var replace = before || after ? "L" : "R";
            for (var j = i; j < end; ++j) types[j] = replace;
            i = end - 1;
          }
        }
  
        // Here we depart from the documented algorithm, in order to avoid
        // building up an actual levels array. Since there are only three
        // levels (0, 1, 2) in an implementation that doesn't take
        // explicit embedding into account, we can build up the order on
        // the fly, without following the level-based algorithm.
        var order = [], m;
        for (var i = 0; i < len;) {
          if (countsAsLeft.test(types[i])) {
            var start = i;
            for (++i; i < len && countsAsLeft.test(types[i]); ++i) {}
            order.push(new BidiSpan(0, start, i));
          } else {
            var pos = i, at = order.length;
            for (++i; i < len && types[i] != "L"; ++i) {}
            for (var j = pos; j < i;) {
              if (countsAsNum.test(types[j])) {
                if (pos < j) order.splice(at, 0, new BidiSpan(1, pos, j));
                var nstart = j;
                for (++j; j < i && countsAsNum.test(types[j]); ++j) {}
                order.splice(at, 0, new BidiSpan(2, nstart, j));
                pos = j;
              } else ++j;
            }
            if (pos < i) order.splice(at, 0, new BidiSpan(1, pos, i));
          }
        }
        if (order[0].level == 1 && (m = str.match(/^\s+/))) {
          order[0].from = m[0].length;
          order.unshift(new BidiSpan(0, 0, m[0].length));
        }
        if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
          lst(order).to -= m[0].length;
          order.push(new BidiSpan(0, len - m[0].length, len));
        }
        if (order[0].level == 2)
          order.unshift(new BidiSpan(1, order[0].to, order[0].to));
        if (order[0].level != lst(order).level)
          order.push(new BidiSpan(order[0].level, len, len));
  
        return order;
      };
    })();
  
    // THE END
  
    CodeMirror.version = "5.5.0";
  
    return CodeMirror;
});

// moment
(function (undefined) {
    /************************************
        Constants
    ************************************/

    var moment,
        VERSION = '2.8.4',
        // the global-scope this is NOT the global object in Node.js
        globalScope = typeof global !== 'undefined' ? global : this,
        oldGlobalMoment,
        round = Math.round,
        hasOwnProperty = Object.prototype.hasOwnProperty,
        i,

        YEAR = 0,
        MONTH = 1,
        DATE = 2,
        HOUR = 3,
        MINUTE = 4,
        SECOND = 5,
        MILLISECOND = 6,

        // internal storage for locale config files
        locales = {},

        // extra moment internal properties (plugins register props here)
        momentProperties = [],

        // check for nodeJS
        hasModule = (typeof module !== 'undefined' && module && module.exports),

        // ASP.NET json date format regex
        aspNetJsonRegex = /^\/?Date\((\-?\d+)/i,
        aspNetTimeSpanJsonRegex = /(\-)?(?:(\d*)\.)?(\d+)\:(\d+)(?:\:(\d+)\.?(\d{3})?)?/,

        // from http://docs.closure-library.googlecode.com/git/closure_goog_date_date.js.source.html
        // somewhat more in line with 4.4.3.2 2004 spec, but allows decimal anywhere
        isoDurationRegex = /^(-)?P(?:(?:([0-9,.]*)Y)?(?:([0-9,.]*)M)?(?:([0-9,.]*)D)?(?:T(?:([0-9,.]*)H)?(?:([0-9,.]*)M)?(?:([0-9,.]*)S)?)?|([0-9,.]*)W)$/,

        // format tokens
        formattingTokens = /(\[[^\[]*\])|(\\)?(Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Q|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|mm?|ss?|S{1,4}|x|X|zz?|ZZ?|.)/g,
        localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g,

        // parsing token regexes
        parseTokenOneOrTwoDigits = /\d\d?/, // 0 - 99
        parseTokenOneToThreeDigits = /\d{1,3}/, // 0 - 999
        parseTokenOneToFourDigits = /\d{1,4}/, // 0 - 9999
        parseTokenOneToSixDigits = /[+\-]?\d{1,6}/, // -999,999 - 999,999
        parseTokenDigits = /\d+/, // nonzero number of digits
        parseTokenWord = /[0-9]*['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+|[\u0600-\u06FF\/]+(\s*?[\u0600-\u06FF]+){1,2}/i, // any word (or two) characters or numbers including two/three word month in arabic.
        parseTokenTimezone = /Z|[\+\-]\d\d:?\d\d/gi, // +00:00 -00:00 +0000 -0000 or Z
        parseTokenT = /T/i, // T (ISO separator)
        parseTokenOffsetMs = /[\+\-]?\d+/, // 1234567890123
        parseTokenTimestampMs = /[\+\-]?\d+(\.\d{1,3})?/, // 123456789 123456789.123

        //strict parsing regexes
        parseTokenOneDigit = /\d/, // 0 - 9
        parseTokenTwoDigits = /\d\d/, // 00 - 99
        parseTokenThreeDigits = /\d{3}/, // 000 - 999
        parseTokenFourDigits = /\d{4}/, // 0000 - 9999
        parseTokenSixDigits = /[+-]?\d{6}/, // -999,999 - 999,999
        parseTokenSignedNumber = /[+-]?\d+/, // -inf - inf

        // iso 8601 regex
        // 0000-00-00 0000-W00 or 0000-W00-0 + T + 00 or 00:00 or 00:00:00 or 00:00:00.000 + +00:00 or +0000 or +00)
        isoRegex = /^\s*(?:[+-]\d{6}|\d{4})-(?:(\d\d-\d\d)|(W\d\d$)|(W\d\d-\d)|(\d\d\d))((T| )(\d\d(:\d\d(:\d\d(\.\d+)?)?)?)?([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/,

        isoFormat = 'YYYY-MM-DDTHH:mm:ssZ',

        isoDates = [
            ['YYYYYY-MM-DD', /[+-]\d{6}-\d{2}-\d{2}/],
            ['YYYY-MM-DD', /\d{4}-\d{2}-\d{2}/],
            ['GGGG-[W]WW-E', /\d{4}-W\d{2}-\d/],
            ['GGGG-[W]WW', /\d{4}-W\d{2}/],
            ['YYYY-DDD', /\d{4}-\d{3}/]
        ],

        // iso time formats and regexes
        isoTimes = [
            ['HH:mm:ss.SSSS', /(T| )\d\d:\d\d:\d\d\.\d+/],
            ['HH:mm:ss', /(T| )\d\d:\d\d:\d\d/],
            ['HH:mm', /(T| )\d\d:\d\d/],
            ['HH', /(T| )\d\d/]
        ],

        // timezone chunker '+10:00' > ['10', '00'] or '-1530' > ['-15', '30']
        parseTimezoneChunker = /([\+\-]|\d\d)/gi,

        // getter and setter names
        proxyGettersAndSetters = 'Date|Hours|Minutes|Seconds|Milliseconds'.split('|'),
        unitMillisecondFactors = {
            'Milliseconds' : 1,
            'Seconds' : 1e3,
            'Minutes' : 6e4,
            'Hours' : 36e5,
            'Days' : 864e5,
            'Months' : 2592e6,
            'Years' : 31536e6
        },

        unitAliases = {
            ms : 'millisecond',
            s : 'second',
            m : 'minute',
            h : 'hour',
            d : 'day',
            D : 'date',
            w : 'week',
            W : 'isoWeek',
            M : 'month',
            Q : 'quarter',
            y : 'year',
            DDD : 'dayOfYear',
            e : 'weekday',
            E : 'isoWeekday',
            gg: 'weekYear',
            GG: 'isoWeekYear'
        },

        camelFunctions = {
            dayofyear : 'dayOfYear',
            isoweekday : 'isoWeekday',
            isoweek : 'isoWeek',
            weekyear : 'weekYear',
            isoweekyear : 'isoWeekYear'
        },

        // format function strings
        formatFunctions = {},

        // default relative time thresholds
        relativeTimeThresholds = {
            s: 45,  // seconds to minute
            m: 45,  // minutes to hour
            h: 22,  // hours to day
            d: 26,  // days to month
            M: 11   // months to year
        },

        // tokens to ordinalize and pad
        ordinalizeTokens = 'DDD w W M D d'.split(' '),
        paddedTokens = 'M D H h m s w W'.split(' '),

        formatTokenFunctions = {
            M    : function () {
                return this.month() + 1;
            },
            MMM  : function (format) {
                return this.localeData().monthsShort(this, format);
            },
            MMMM : function (format) {
                return this.localeData().months(this, format);
            },
            D    : function () {
                return this.date();
            },
            DDD  : function () {
                return this.dayOfYear();
            },
            d    : function () {
                return this.day();
            },
            dd   : function (format) {
                return this.localeData().weekdaysMin(this, format);
            },
            ddd  : function (format) {
                return this.localeData().weekdaysShort(this, format);
            },
            dddd : function (format) {
                return this.localeData().weekdays(this, format);
            },
            w    : function () {
                return this.week();
            },
            W    : function () {
                return this.isoWeek();
            },
            YY   : function () {
                return leftZeroFill(this.year() % 100, 2);
            },
            YYYY : function () {
                return leftZeroFill(this.year(), 4);
            },
            YYYYY : function () {
                return leftZeroFill(this.year(), 5);
            },
            YYYYYY : function () {
                var y = this.year(), sign = y >= 0 ? '+' : '-';
                return sign + leftZeroFill(Math.abs(y), 6);
            },
            gg   : function () {
                return leftZeroFill(this.weekYear() % 100, 2);
            },
            gggg : function () {
                return leftZeroFill(this.weekYear(), 4);
            },
            ggggg : function () {
                return leftZeroFill(this.weekYear(), 5);
            },
            GG   : function () {
                return leftZeroFill(this.isoWeekYear() % 100, 2);
            },
            GGGG : function () {
                return leftZeroFill(this.isoWeekYear(), 4);
            },
            GGGGG : function () {
                return leftZeroFill(this.isoWeekYear(), 5);
            },
            e : function () {
                return this.weekday();
            },
            E : function () {
                return this.isoWeekday();
            },
            a    : function () {
                return this.localeData().meridiem(this.hours(), this.minutes(), true);
            },
            A    : function () {
                return this.localeData().meridiem(this.hours(), this.minutes(), false);
            },
            H    : function () {
                return this.hours();
            },
            h    : function () {
                return this.hours() % 12 || 12;
            },
            m    : function () {
                return this.minutes();
            },
            s    : function () {
                return this.seconds();
            },
            S    : function () {
                return toInt(this.milliseconds() / 100);
            },
            SS   : function () {
                return leftZeroFill(toInt(this.milliseconds() / 10), 2);
            },
            SSS  : function () {
                return leftZeroFill(this.milliseconds(), 3);
            },
            SSSS : function () {
                return leftZeroFill(this.milliseconds(), 3);
            },
            Z    : function () {
                var a = -this.zone(),
                    b = '+';
                if (a < 0) {
                    a = -a;
                    b = '-';
                }
                return b + leftZeroFill(toInt(a / 60), 2) + ':' + leftZeroFill(toInt(a) % 60, 2);
            },
            ZZ   : function () {
                var a = -this.zone(),
                    b = '+';
                if (a < 0) {
                    a = -a;
                    b = '-';
                }
                return b + leftZeroFill(toInt(a / 60), 2) + leftZeroFill(toInt(a) % 60, 2);
            },
            z : function () {
                return this.zoneAbbr();
            },
            zz : function () {
                return this.zoneName();
            },
            x    : function () {
                return this.valueOf();
            },
            X    : function () {
                return this.unix();
            },
            Q : function () {
                return this.quarter();
            }
        },

        deprecations = {},

        lists = ['months', 'monthsShort', 'weekdays', 'weekdaysShort', 'weekdaysMin'];

    // Pick the first defined of two or three arguments. dfl comes from
    // default.
    function dfl(a, b, c) {
        switch (arguments.length) {
            case 2: return a != null ? a : b;
            case 3: return a != null ? a : b != null ? b : c;
            default: throw new Error('Implement me');
        }
    }

    function hasOwnProp(a, b) {
        return hasOwnProperty.call(a, b);
    }

    function defaultParsingFlags() {
        // We need to deep clone this object, and es5 standard is not very
        // helpful.
        return {
            empty : false,
            unusedTokens : [],
            unusedInput : [],
            overflow : -2,
            charsLeftOver : 0,
            nullInput : false,
            invalidMonth : null,
            invalidFormat : false,
            userInvalidated : false,
            iso: false
        };
    }

    function printMsg(msg) {
        if (moment.suppressDeprecationWarnings === false &&
                typeof console !== 'undefined' && console.warn) {
            console.warn('Deprecation warning: ' + msg);
        }
    }

    function deprecate(msg, fn) {
        var firstTime = true;
        return extend(function () {
            if (firstTime) {
                printMsg(msg);
                firstTime = false;
            }
            return fn.apply(this, arguments);
        }, fn);
    }

    function deprecateSimple(name, msg) {
        if (!deprecations[name]) {
            printMsg(msg);
            deprecations[name] = true;
        }
    }

    function padToken(func, count) {
        return function (a) {
            return leftZeroFill(func.call(this, a), count);
        };
    }
    function ordinalizeToken(func, period) {
        return function (a) {
            return this.localeData().ordinal(func.call(this, a), period);
        };
    }

    while (ordinalizeTokens.length) {
        i = ordinalizeTokens.pop();
        formatTokenFunctions[i + 'o'] = ordinalizeToken(formatTokenFunctions[i], i);
    }
    while (paddedTokens.length) {
        i = paddedTokens.pop();
        formatTokenFunctions[i + i] = padToken(formatTokenFunctions[i], 2);
    }
    formatTokenFunctions.DDDD = padToken(formatTokenFunctions.DDD, 3);


    /************************************
        Constructors
    ************************************/

    function Locale() {
    }

    // Moment prototype object
    function Moment(config, skipOverflow) {
        if (skipOverflow !== false) {
            checkOverflow(config);
        }
        copyConfig(this, config);
        this._d = new Date(+config._d);
    }

    // Duration Constructor
    function Duration(duration) {
        var normalizedInput = normalizeObjectUnits(duration),
            years = normalizedInput.year || 0,
            quarters = normalizedInput.quarter || 0,
            months = normalizedInput.month || 0,
            weeks = normalizedInput.week || 0,
            days = normalizedInput.day || 0,
            hours = normalizedInput.hour || 0,
            minutes = normalizedInput.minute || 0,
            seconds = normalizedInput.second || 0,
            milliseconds = normalizedInput.millisecond || 0;

        // representation for dateAddRemove
        this._milliseconds = +milliseconds +
            seconds * 1e3 + // 1000
            minutes * 6e4 + // 1000 * 60
            hours * 36e5; // 1000 * 60 * 60
        // Because of dateAddRemove treats 24 hours as different from a
        // day when working around DST, we need to store them separately
        this._days = +days +
            weeks * 7;
        // It is impossible translate months into days without knowing
        // which months you are are talking about, so we have to store
        // it separately.
        this._months = +months +
            quarters * 3 +
            years * 12;

        this._data = {};

        this._locale = moment.localeData();

        this._bubble();
    }

    /************************************
        Helpers
    ************************************/


    function extend(a, b) {
        for (var i in b) {
            if (hasOwnProp(b, i)) {
                a[i] = b[i];
            }
        }

        if (hasOwnProp(b, 'toString')) {
            a.toString = b.toString;
        }

        if (hasOwnProp(b, 'valueOf')) {
            a.valueOf = b.valueOf;
        }

        return a;
    }

    function copyConfig(to, from) {
        var i, prop, val;

        if (typeof from._isAMomentObject !== 'undefined') {
            to._isAMomentObject = from._isAMomentObject;
        }
        if (typeof from._i !== 'undefined') {
            to._i = from._i;
        }
        if (typeof from._f !== 'undefined') {
            to._f = from._f;
        }
        if (typeof from._l !== 'undefined') {
            to._l = from._l;
        }
        if (typeof from._strict !== 'undefined') {
            to._strict = from._strict;
        }
        if (typeof from._tzm !== 'undefined') {
            to._tzm = from._tzm;
        }
        if (typeof from._isUTC !== 'undefined') {
            to._isUTC = from._isUTC;
        }
        if (typeof from._offset !== 'undefined') {
            to._offset = from._offset;
        }
        if (typeof from._pf !== 'undefined') {
            to._pf = from._pf;
        }
        if (typeof from._locale !== 'undefined') {
            to._locale = from._locale;
        }

        if (momentProperties.length > 0) {
            for (i in momentProperties) {
                prop = momentProperties[i];
                val = from[prop];
                if (typeof val !== 'undefined') {
                    to[prop] = val;
                }
            }
        }

        return to;
    }

    function absRound(number) {
        if (number < 0) {
            return Math.ceil(number);
        } else {
            return Math.floor(number);
        }
    }

    // left zero fill a number
    // see http://jsperf.com/left-zero-filling for performance comparison
    function leftZeroFill(number, targetLength, forceSign) {
        var output = '' + Math.abs(number),
            sign = number >= 0;

        while (output.length < targetLength) {
            output = '0' + output;
        }
        return (sign ? (forceSign ? '+' : '') : '-') + output;
    }

    function positiveMomentsDifference(base, other) {
        var res = {milliseconds: 0, months: 0};

        res.months = other.month() - base.month() +
            (other.year() - base.year()) * 12;
        if (base.clone().add(res.months, 'M').isAfter(other)) {
            --res.months;
        }

        res.milliseconds = +other - +(base.clone().add(res.months, 'M'));

        return res;
    }

    function momentsDifference(base, other) {
        var res;
        other = makeAs(other, base);
        if (base.isBefore(other)) {
            res = positiveMomentsDifference(base, other);
        } else {
            res = positiveMomentsDifference(other, base);
            res.milliseconds = -res.milliseconds;
            res.months = -res.months;
        }

        return res;
    }

    // TODO: remove 'name' arg after deprecation is removed
    function createAdder(direction, name) {
        return function (val, period) {
            var dur, tmp;
            //invert the arguments, but complain about it
            if (period !== null && !isNaN(+period)) {
                deprecateSimple(name, 'moment().' + name  + '(period, number) is deprecated. Please use moment().' + name + '(number, period).');
                tmp = val; val = period; period = tmp;
            }

            val = typeof val === 'string' ? +val : val;
            dur = moment.duration(val, period);
            addOrSubtractDurationFromMoment(this, dur, direction);
            return this;
        };
    }

    function addOrSubtractDurationFromMoment(mom, duration, isAdding, updateOffset) {
        var milliseconds = duration._milliseconds,
            days = duration._days,
            months = duration._months;
        updateOffset = updateOffset == null ? true : updateOffset;

        if (milliseconds) {
            mom._d.setTime(+mom._d + milliseconds * isAdding);
        }
        if (days) {
            rawSetter(mom, 'Date', rawGetter(mom, 'Date') + days * isAdding);
        }
        if (months) {
            rawMonthSetter(mom, rawGetter(mom, 'Month') + months * isAdding);
        }
        if (updateOffset) {
            moment.updateOffset(mom, days || months);
        }
    }

    // check if is an array
    function isArray(input) {
        return Object.prototype.toString.call(input) === '[object Array]';
    }

    function isDate(input) {
        return Object.prototype.toString.call(input) === '[object Date]' ||
            input instanceof Date;
    }

    // compare two arrays, return the number of differences
    function compareArrays(array1, array2, dontConvert) {
        var len = Math.min(array1.length, array2.length),
            lengthDiff = Math.abs(array1.length - array2.length),
            diffs = 0,
            i;
        for (i = 0; i < len; i++) {
            if ((dontConvert && array1[i] !== array2[i]) ||
                (!dontConvert && toInt(array1[i]) !== toInt(array2[i]))) {
                diffs++;
            }
        }
        return diffs + lengthDiff;
    }

    function normalizeUnits(units) {
        if (units) {
            var lowered = units.toLowerCase().replace(/(.)s$/, '$1');
            units = unitAliases[units] || camelFunctions[lowered] || lowered;
        }
        return units;
    }

    function normalizeObjectUnits(inputObject) {
        var normalizedInput = {},
            normalizedProp,
            prop;

        for (prop in inputObject) {
            if (hasOwnProp(inputObject, prop)) {
                normalizedProp = normalizeUnits(prop);
                if (normalizedProp) {
                    normalizedInput[normalizedProp] = inputObject[prop];
                }
            }
        }

        return normalizedInput;
    }

    function makeList(field) {
        var count, setter;

        if (field.indexOf('week') === 0) {
            count = 7;
            setter = 'day';
        }
        else if (field.indexOf('month') === 0) {
            count = 12;
            setter = 'month';
        }
        else {
            return;
        }

        moment[field] = function (format, index) {
            var i, getter,
                method = moment._locale[field],
                results = [];

            if (typeof format === 'number') {
                index = format;
                format = undefined;
            }

            getter = function (i) {
                var m = moment().utc().set(setter, i);
                return method.call(moment._locale, m, format || '');
            };

            if (index != null) {
                return getter(index);
            }
            else {
                for (i = 0; i < count; i++) {
                    results.push(getter(i));
                }
                return results;
            }
        };
    }

    function toInt(argumentForCoercion) {
        var coercedNumber = +argumentForCoercion,
            value = 0;

        if (coercedNumber !== 0 && isFinite(coercedNumber)) {
            if (coercedNumber >= 0) {
                value = Math.floor(coercedNumber);
            } else {
                value = Math.ceil(coercedNumber);
            }
        }

        return value;
    }

    function daysInMonth(year, month) {
        return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    }

    function weeksInYear(year, dow, doy) {
        return weekOfYear(moment([year, 11, 31 + dow - doy]), dow, doy).week;
    }

    function daysInYear(year) {
        return isLeapYear(year) ? 366 : 365;
    }

    function isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }

    function checkOverflow(m) {
        var overflow;
        if (m._a && m._pf.overflow === -2) {
            overflow =
                m._a[MONTH] < 0 || m._a[MONTH] > 11 ? MONTH :
                m._a[DATE] < 1 || m._a[DATE] > daysInMonth(m._a[YEAR], m._a[MONTH]) ? DATE :
                m._a[HOUR] < 0 || m._a[HOUR] > 24 ||
                    (m._a[HOUR] === 24 && (m._a[MINUTE] !== 0 ||
                                           m._a[SECOND] !== 0 ||
                                           m._a[MILLISECOND] !== 0)) ? HOUR :
                m._a[MINUTE] < 0 || m._a[MINUTE] > 59 ? MINUTE :
                m._a[SECOND] < 0 || m._a[SECOND] > 59 ? SECOND :
                m._a[MILLISECOND] < 0 || m._a[MILLISECOND] > 999 ? MILLISECOND :
                -1;

            if (m._pf._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
                overflow = DATE;
            }

            m._pf.overflow = overflow;
        }
    }

    function isValid(m) {
        if (m._isValid == null) {
            m._isValid = !isNaN(m._d.getTime()) &&
                m._pf.overflow < 0 &&
                !m._pf.empty &&
                !m._pf.invalidMonth &&
                !m._pf.nullInput &&
                !m._pf.invalidFormat &&
                !m._pf.userInvalidated;

            if (m._strict) {
                m._isValid = m._isValid &&
                    m._pf.charsLeftOver === 0 &&
                    m._pf.unusedTokens.length === 0 &&
                    m._pf.bigHour === undefined;
            }
        }
        return m._isValid;
    }

    function normalizeLocale(key) {
        return key ? key.toLowerCase().replace('_', '-') : key;
    }

    // pick the locale from the array
    // try ['en-au', 'en-gb'] as 'en-au', 'en-gb', 'en', as in move through the list trying each
    // substring from most specific to least, but move to the next array item if it's a more specific variant than the current root
    function chooseLocale(names) {
        var i = 0, j, next, locale, split;

        while (i < names.length) {
            split = normalizeLocale(names[i]).split('-');
            j = split.length;
            next = normalizeLocale(names[i + 1]);
            next = next ? next.split('-') : null;
            while (j > 0) {
                locale = loadLocale(split.slice(0, j).join('-'));
                if (locale) {
                    return locale;
                }
                if (next && next.length >= j && compareArrays(split, next, true) >= j - 1) {
                    //the next array item is better than a shallower substring of this one
                    break;
                }
                j--;
            }
            i++;
        }
        return null;
    }

    function loadLocale(name) {
        var oldLocale = null;
        if (!locales[name] && hasModule) {
            try {
                oldLocale = moment.locale();
                // require('./locale/' + name);
                // because defineLocale currently also sets the global locale, we want to undo that for lazy loaded locales
                moment.locale(oldLocale);
            } catch (e) { }
        }
        return locales[name];
    }

    // Return a moment from input, that is local/utc/zone equivalent to model.
    function makeAs(input, model) {
        var res, diff;
        if (model._isUTC) {
            res = model.clone();
            diff = (moment.isMoment(input) || isDate(input) ?
                    +input : +moment(input)) - (+res);
            // Use low-level api, because this fn is low-level api.
            res._d.setTime(+res._d + diff);
            moment.updateOffset(res, false);
            return res;
        } else {
            return moment(input).local();
        }
    }

    /************************************
        Locale
    ************************************/


    extend(Locale.prototype, {

        set : function (config) {
            var prop, i;
            for (i in config) {
                prop = config[i];
                if (typeof prop === 'function') {
                    this[i] = prop;
                } else {
                    this['_' + i] = prop;
                }
            }
            // Lenient ordinal parsing accepts just a number in addition to
            // number + (possibly) stuff coming from _ordinalParseLenient.
            this._ordinalParseLenient = new RegExp(this._ordinalParse.source + '|' + /\d{1,2}/.source);
        },

        _months : 'January_February_March_April_May_June_July_August_September_October_November_December'.split('_'),
        months : function (m) {
            return this._months[m.month()];
        },

        _monthsShort : 'Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec'.split('_'),
        monthsShort : function (m) {
            return this._monthsShort[m.month()];
        },

        monthsParse : function (monthName, format, strict) {
            var i, mom, regex;

            if (!this._monthsParse) {
                this._monthsParse = [];
                this._longMonthsParse = [];
                this._shortMonthsParse = [];
            }

            for (i = 0; i < 12; i++) {
                // make the regex if we don't have it already
                mom = moment.utc([2000, i]);
                if (strict && !this._longMonthsParse[i]) {
                    this._longMonthsParse[i] = new RegExp('^' + this.months(mom, '').replace('.', '') + '$', 'i');
                    this._shortMonthsParse[i] = new RegExp('^' + this.monthsShort(mom, '').replace('.', '') + '$', 'i');
                }
                if (!strict && !this._monthsParse[i]) {
                    regex = '^' + this.months(mom, '') + '|^' + this.monthsShort(mom, '');
                    this._monthsParse[i] = new RegExp(regex.replace('.', ''), 'i');
                }
                // test the regex
                if (strict && format === 'MMMM' && this._longMonthsParse[i].test(monthName)) {
                    return i;
                } else if (strict && format === 'MMM' && this._shortMonthsParse[i].test(monthName)) {
                    return i;
                } else if (!strict && this._monthsParse[i].test(monthName)) {
                    return i;
                }
            }
        },

        _weekdays : 'Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday'.split('_'),
        weekdays : function (m) {
            return this._weekdays[m.day()];
        },

        _weekdaysShort : 'Sun_Mon_Tue_Wed_Thu_Fri_Sat'.split('_'),
        weekdaysShort : function (m) {
            return this._weekdaysShort[m.day()];
        },

        _weekdaysMin : 'Su_Mo_Tu_We_Th_Fr_Sa'.split('_'),
        weekdaysMin : function (m) {
            return this._weekdaysMin[m.day()];
        },

        weekdaysParse : function (weekdayName) {
            var i, mom, regex;

            if (!this._weekdaysParse) {
                this._weekdaysParse = [];
            }

            for (i = 0; i < 7; i++) {
                // make the regex if we don't have it already
                if (!this._weekdaysParse[i]) {
                    mom = moment([2000, 1]).day(i);
                    regex = '^' + this.weekdays(mom, '') + '|^' + this.weekdaysShort(mom, '') + '|^' + this.weekdaysMin(mom, '');
                    this._weekdaysParse[i] = new RegExp(regex.replace('.', ''), 'i');
                }
                // test the regex
                if (this._weekdaysParse[i].test(weekdayName)) {
                    return i;
                }
            }
        },

        _longDateFormat : {
            LTS : 'h:mm:ss A',
            LT : 'h:mm A',
            L : 'MM/DD/YYYY',
            LL : 'MMMM D, YYYY',
            LLL : 'MMMM D, YYYY LT',
            LLLL : 'dddd, MMMM D, YYYY LT'
        },
        longDateFormat : function (key) {
            var output = this._longDateFormat[key];
            if (!output && this._longDateFormat[key.toUpperCase()]) {
                output = this._longDateFormat[key.toUpperCase()].replace(/MMMM|MM|DD|dddd/g, function (val) {
                    return val.slice(1);
                });
                this._longDateFormat[key] = output;
            }
            return output;
        },

        isPM : function (input) {
            // IE8 Quirks Mode & IE7 Standards Mode do not allow accessing strings like arrays
            // Using charAt should be more compatible.
            return ((input + '').toLowerCase().charAt(0) === 'p');
        },

        _meridiemParse : /[ap]\.?m?\.?/i,
        meridiem : function (hours, minutes, isLower) {
            if (hours > 11) {
                return isLower ? 'pm' : 'PM';
            } else {
                return isLower ? 'am' : 'AM';
            }
        },

        _calendar : {
            sameDay : '[Today at] LT',
            nextDay : '[Tomorrow at] LT',
            nextWeek : 'dddd [at] LT',
            lastDay : '[Yesterday at] LT',
            lastWeek : '[Last] dddd [at] LT',
            sameElse : 'L'
        },
        calendar : function (key, mom, now) {
            var output = this._calendar[key];
            return typeof output === 'function' ? output.apply(mom, [now]) : output;
        },

        _relativeTime : {
            future : 'in %s',
            past : '%s ago',
            s : 'a few seconds',
            m : 'a minute',
            mm : '%d minutes',
            h : 'an hour',
            hh : '%d hours',
            d : 'a day',
            dd : '%d days',
            M : 'a month',
            MM : '%d months',
            y : 'a year',
            yy : '%d years'
        },

        relativeTime : function (number, withoutSuffix, string, isFuture) {
            var output = this._relativeTime[string];
            return (typeof output === 'function') ?
                output(number, withoutSuffix, string, isFuture) :
                output.replace(/%d/i, number);
        },

        pastFuture : function (diff, output) {
            var format = this._relativeTime[diff > 0 ? 'future' : 'past'];
            return typeof format === 'function' ? format(output) : format.replace(/%s/i, output);
        },

        ordinal : function (number) {
            return this._ordinal.replace('%d', number);
        },
        _ordinal : '%d',
        _ordinalParse : /\d{1,2}/,

        preparse : function (string) {
            return string;
        },

        postformat : function (string) {
            return string;
        },

        week : function (mom) {
            return weekOfYear(mom, this._week.dow, this._week.doy).week;
        },

        _week : {
            dow : 0, // Sunday is the first day of the week.
            doy : 6  // The week that contains Jan 1st is the first week of the year.
        },

        _invalidDate: 'Invalid date',
        invalidDate: function () {
            return this._invalidDate;
        }
    });

    /************************************
        Formatting
    ************************************/


    function removeFormattingTokens(input) {
        if (input.match(/\[[\s\S]/)) {
            return input.replace(/^\[|\]$/g, '');
        }
        return input.replace(/\\/g, '');
    }

    function makeFormatFunction(format) {
        var array = format.match(formattingTokens), i, length;

        for (i = 0, length = array.length; i < length; i++) {
            if (formatTokenFunctions[array[i]]) {
                array[i] = formatTokenFunctions[array[i]];
            } else {
                array[i] = removeFormattingTokens(array[i]);
            }
        }

        return function (mom) {
            var output = '';
            for (i = 0; i < length; i++) {
                output += array[i] instanceof Function ? array[i].call(mom, format) : array[i];
            }
            return output;
        };
    }

    // format date using native date object
    function formatMoment(m, format) {
        if (!m.isValid()) {
            return m.localeData().invalidDate();
        }

        format = expandFormat(format, m.localeData());

        if (!formatFunctions[format]) {
            formatFunctions[format] = makeFormatFunction(format);
        }

        return formatFunctions[format](m);
    }

    function expandFormat(format, locale) {
        var i = 5;

        function replaceLongDateFormatTokens(input) {
            return locale.longDateFormat(input) || input;
        }

        localFormattingTokens.lastIndex = 0;
        while (i >= 0 && localFormattingTokens.test(format)) {
            format = format.replace(localFormattingTokens, replaceLongDateFormatTokens);
            localFormattingTokens.lastIndex = 0;
            i -= 1;
        }

        return format;
    }


    /************************************
        Parsing
    ************************************/


    // get the regex to find the next token
    function getParseRegexForToken(token, config) {
        var a, strict = config._strict;
        switch (token) {
        case 'Q':
            return parseTokenOneDigit;
        case 'DDDD':
            return parseTokenThreeDigits;
        case 'YYYY':
        case 'GGGG':
        case 'gggg':
            return strict ? parseTokenFourDigits : parseTokenOneToFourDigits;
        case 'Y':
        case 'G':
        case 'g':
            return parseTokenSignedNumber;
        case 'YYYYYY':
        case 'YYYYY':
        case 'GGGGG':
        case 'ggggg':
            return strict ? parseTokenSixDigits : parseTokenOneToSixDigits;
        case 'S':
            if (strict) {
                return parseTokenOneDigit;
            }
            /* falls through */
        case 'SS':
            if (strict) {
                return parseTokenTwoDigits;
            }
            /* falls through */
        case 'SSS':
            if (strict) {
                return parseTokenThreeDigits;
            }
            /* falls through */
        case 'DDD':
            return parseTokenOneToThreeDigits;
        case 'MMM':
        case 'MMMM':
        case 'dd':
        case 'ddd':
        case 'dddd':
            return parseTokenWord;
        case 'a':
        case 'A':
            return config._locale._meridiemParse;
        case 'x':
            return parseTokenOffsetMs;
        case 'X':
            return parseTokenTimestampMs;
        case 'Z':
        case 'ZZ':
            return parseTokenTimezone;
        case 'T':
            return parseTokenT;
        case 'SSSS':
            return parseTokenDigits;
        case 'MM':
        case 'DD':
        case 'YY':
        case 'GG':
        case 'gg':
        case 'HH':
        case 'hh':
        case 'mm':
        case 'ss':
        case 'ww':
        case 'WW':
            return strict ? parseTokenTwoDigits : parseTokenOneOrTwoDigits;
        case 'M':
        case 'D':
        case 'd':
        case 'H':
        case 'h':
        case 'm':
        case 's':
        case 'w':
        case 'W':
        case 'e':
        case 'E':
            return parseTokenOneOrTwoDigits;
        case 'Do':
            return strict ? config._locale._ordinalParse : config._locale._ordinalParseLenient;
        default :
            a = new RegExp(regexpEscape(unescapeFormat(token.replace('\\', '')), 'i'));
            return a;
        }
    }

    function timezoneMinutesFromString(string) {
        string = string || '';
        var possibleTzMatches = (string.match(parseTokenTimezone) || []),
            tzChunk = possibleTzMatches[possibleTzMatches.length - 1] || [],
            parts = (tzChunk + '').match(parseTimezoneChunker) || ['-', 0, 0],
            minutes = +(parts[1] * 60) + toInt(parts[2]);

        return parts[0] === '+' ? -minutes : minutes;
    }

    // function to convert string input to date
    function addTimeToArrayFromToken(token, input, config) {
        var a, datePartArray = config._a;

        switch (token) {
        // QUARTER
        case 'Q':
            if (input != null) {
                datePartArray[MONTH] = (toInt(input) - 1) * 3;
            }
            break;
        // MONTH
        case 'M' : // fall through to MM
        case 'MM' :
            if (input != null) {
                datePartArray[MONTH] = toInt(input) - 1;
            }
            break;
        case 'MMM' : // fall through to MMMM
        case 'MMMM' :
            a = config._locale.monthsParse(input, token, config._strict);
            // if we didn't find a month name, mark the date as invalid.
            if (a != null) {
                datePartArray[MONTH] = a;
            } else {
                config._pf.invalidMonth = input;
            }
            break;
        // DAY OF MONTH
        case 'D' : // fall through to DD
        case 'DD' :
            if (input != null) {
                datePartArray[DATE] = toInt(input);
            }
            break;
        case 'Do' :
            if (input != null) {
                datePartArray[DATE] = toInt(parseInt(
                            input.match(/\d{1,2}/)[0], 10));
            }
            break;
        // DAY OF YEAR
        case 'DDD' : // fall through to DDDD
        case 'DDDD' :
            if (input != null) {
                config._dayOfYear = toInt(input);
            }

            break;
        // YEAR
        case 'YY' :
            datePartArray[YEAR] = moment.parseTwoDigitYear(input);
            break;
        case 'YYYY' :
        case 'YYYYY' :
        case 'YYYYYY' :
            datePartArray[YEAR] = toInt(input);
            break;
        // AM / PM
        case 'a' : // fall through to A
        case 'A' :
            config._isPm = config._locale.isPM(input);
            break;
        // HOUR
        case 'h' : // fall through to hh
        case 'hh' :
            config._pf.bigHour = true;
            /* falls through */
        case 'H' : // fall through to HH
        case 'HH' :
            datePartArray[HOUR] = toInt(input);
            break;
        // MINUTE
        case 'm' : // fall through to mm
        case 'mm' :
            datePartArray[MINUTE] = toInt(input);
            break;
        // SECOND
        case 's' : // fall through to ss
        case 'ss' :
            datePartArray[SECOND] = toInt(input);
            break;
        // MILLISECOND
        case 'S' :
        case 'SS' :
        case 'SSS' :
        case 'SSSS' :
            datePartArray[MILLISECOND] = toInt(('0.' + input) * 1000);
            break;
        // UNIX OFFSET (MILLISECONDS)
        case 'x':
            config._d = new Date(toInt(input));
            break;
        // UNIX TIMESTAMP WITH MS
        case 'X':
            config._d = new Date(parseFloat(input) * 1000);
            break;
        // TIMEZONE
        case 'Z' : // fall through to ZZ
        case 'ZZ' :
            config._useUTC = true;
            config._tzm = timezoneMinutesFromString(input);
            break;
        // WEEKDAY - human
        case 'dd':
        case 'ddd':
        case 'dddd':
            a = config._locale.weekdaysParse(input);
            // if we didn't get a weekday name, mark the date as invalid
            if (a != null) {
                config._w = config._w || {};
                config._w['d'] = a;
            } else {
                config._pf.invalidWeekday = input;
            }
            break;
        // WEEK, WEEK DAY - numeric
        case 'w':
        case 'ww':
        case 'W':
        case 'WW':
        case 'd':
        case 'e':
        case 'E':
            token = token.substr(0, 1);
            /* falls through */
        case 'gggg':
        case 'GGGG':
        case 'GGGGG':
            token = token.substr(0, 2);
            if (input) {
                config._w = config._w || {};
                config._w[token] = toInt(input);
            }
            break;
        case 'gg':
        case 'GG':
            config._w = config._w || {};
            config._w[token] = moment.parseTwoDigitYear(input);
        }
    }

    function dayOfYearFromWeekInfo(config) {
        var w, weekYear, week, weekday, dow, doy, temp;

        w = config._w;
        if (w.GG != null || w.W != null || w.E != null) {
            dow = 1;
            doy = 4;

            // TODO: We need to take the current isoWeekYear, but that depends on
            // how we interpret now (local, utc, fixed offset). So create
            // a now version of current config (take local/utc/offset flags, and
            // create now).
            weekYear = dfl(w.GG, config._a[YEAR], weekOfYear(moment(), 1, 4).year);
            week = dfl(w.W, 1);
            weekday = dfl(w.E, 1);
        } else {
            dow = config._locale._week.dow;
            doy = config._locale._week.doy;

            weekYear = dfl(w.gg, config._a[YEAR], weekOfYear(moment(), dow, doy).year);
            week = dfl(w.w, 1);

            if (w.d != null) {
                // weekday -- low day numbers are considered next week
                weekday = w.d;
                if (weekday < dow) {
                    ++week;
                }
            } else if (w.e != null) {
                // local weekday -- counting starts from begining of week
                weekday = w.e + dow;
            } else {
                // default to begining of week
                weekday = dow;
            }
        }
        temp = dayOfYearFromWeeks(weekYear, week, weekday, doy, dow);

        config._a[YEAR] = temp.year;
        config._dayOfYear = temp.dayOfYear;
    }

    // convert an array to a date.
    // the array should mirror the parameters below
    // note: all values past the year are optional and will default to the lowest possible value.
    // [year, month, day , hour, minute, second, millisecond]
    function dateFromConfig(config) {
        var i, date, input = [], currentDate, yearToUse;

        if (config._d) {
            return;
        }

        currentDate = currentDateArray(config);

        //compute day of the year from weeks and weekdays
        if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
            dayOfYearFromWeekInfo(config);
        }

        //if the day of the year is set, figure out what it is
        if (config._dayOfYear) {
            yearToUse = dfl(config._a[YEAR], currentDate[YEAR]);

            if (config._dayOfYear > daysInYear(yearToUse)) {
                config._pf._overflowDayOfYear = true;
            }

            date = makeUTCDate(yearToUse, 0, config._dayOfYear);
            config._a[MONTH] = date.getUTCMonth();
            config._a[DATE] = date.getUTCDate();
        }

        // Default to current date.
        // * if no year, month, day of month are given, default to today
        // * if day of month is given, default month and year
        // * if month is given, default only year
        // * if year is given, don't default anything
        for (i = 0; i < 3 && config._a[i] == null; ++i) {
            config._a[i] = input[i] = currentDate[i];
        }

        // Zero out whatever was not defaulted, including time
        for (; i < 7; i++) {
            config._a[i] = input[i] = (config._a[i] == null) ? (i === 2 ? 1 : 0) : config._a[i];
        }

        // Check for 24:00:00.000
        if (config._a[HOUR] === 24 &&
                config._a[MINUTE] === 0 &&
                config._a[SECOND] === 0 &&
                config._a[MILLISECOND] === 0) {
            config._nextDay = true;
            config._a[HOUR] = 0;
        }

        config._d = (config._useUTC ? makeUTCDate : makeDate).apply(null, input);
        // Apply timezone offset from input. The actual zone can be changed
        // with parseZone.
        if (config._tzm != null) {
            config._d.setUTCMinutes(config._d.getUTCMinutes() + config._tzm);
        }

        if (config._nextDay) {
            config._a[HOUR] = 24;
        }
    }

    function dateFromObject(config) {
        var normalizedInput;

        if (config._d) {
            return;
        }

        normalizedInput = normalizeObjectUnits(config._i);
        config._a = [
            normalizedInput.year,
            normalizedInput.month,
            normalizedInput.day || normalizedInput.date,
            normalizedInput.hour,
            normalizedInput.minute,
            normalizedInput.second,
            normalizedInput.millisecond
        ];

        dateFromConfig(config);
    }

    function currentDateArray(config) {
        var now = new Date();
        if (config._useUTC) {
            return [
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate()
            ];
        } else {
            return [now.getFullYear(), now.getMonth(), now.getDate()];
        }
    }

    // date from string and format string
    function makeDateFromStringAndFormat(config) {
        if (config._f === moment.ISO_8601) {
            parseISO(config);
            return;
        }

        config._a = [];
        config._pf.empty = true;

        // This array is used to make a Date, either with `new Date` or `Date.UTC`
        var string = '' + config._i,
            i, parsedInput, tokens, token, skipped,
            stringLength = string.length,
            totalParsedInputLength = 0;

        tokens = expandFormat(config._f, config._locale).match(formattingTokens) || [];

        for (i = 0; i < tokens.length; i++) {
            token = tokens[i];
            parsedInput = (string.match(getParseRegexForToken(token, config)) || [])[0];
            if (parsedInput) {
                skipped = string.substr(0, string.indexOf(parsedInput));
                if (skipped.length > 0) {
                    config._pf.unusedInput.push(skipped);
                }
                string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
                totalParsedInputLength += parsedInput.length;
            }
            // don't parse if it's not a known token
            if (formatTokenFunctions[token]) {
                if (parsedInput) {
                    config._pf.empty = false;
                }
                else {
                    config._pf.unusedTokens.push(token);
                }
                addTimeToArrayFromToken(token, parsedInput, config);
            }
            else if (config._strict && !parsedInput) {
                config._pf.unusedTokens.push(token);
            }
        }

        // add remaining unparsed input length to the string
        config._pf.charsLeftOver = stringLength - totalParsedInputLength;
        if (string.length > 0) {
            config._pf.unusedInput.push(string);
        }

        // clear _12h flag if hour is <= 12
        if (config._pf.bigHour === true && config._a[HOUR] <= 12) {
            config._pf.bigHour = undefined;
        }
        // handle am pm
        if (config._isPm && config._a[HOUR] < 12) {
            config._a[HOUR] += 12;
        }
        // if is 12 am, change hours to 0
        if (config._isPm === false && config._a[HOUR] === 12) {
            config._a[HOUR] = 0;
        }
        dateFromConfig(config);
        checkOverflow(config);
    }

    function unescapeFormat(s) {
        return s.replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function (matched, p1, p2, p3, p4) {
            return p1 || p2 || p3 || p4;
        });
    }

    // Code from http://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
    function regexpEscape(s) {
        return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    }

    // date from string and array of format strings
    function makeDateFromStringAndArray(config) {
        var tempConfig,
            bestMoment,

            scoreToBeat,
            i,
            currentScore;

        if (config._f.length === 0) {
            config._pf.invalidFormat = true;
            config._d = new Date(NaN);
            return;
        }

        for (i = 0; i < config._f.length; i++) {
            currentScore = 0;
            tempConfig = copyConfig({}, config);
            if (config._useUTC != null) {
                tempConfig._useUTC = config._useUTC;
            }
            tempConfig._pf = defaultParsingFlags();
            tempConfig._f = config._f[i];
            makeDateFromStringAndFormat(tempConfig);

            if (!isValid(tempConfig)) {
                continue;
            }

            // if there is any input that was not parsed add a penalty for that format
            currentScore += tempConfig._pf.charsLeftOver;

            //or tokens
            currentScore += tempConfig._pf.unusedTokens.length * 10;

            tempConfig._pf.score = currentScore;

            if (scoreToBeat == null || currentScore < scoreToBeat) {
                scoreToBeat = currentScore;
                bestMoment = tempConfig;
            }
        }

        extend(config, bestMoment || tempConfig);
    }

    // date from iso format
    function parseISO(config) {
        var i, l,
            string = config._i,
            match = isoRegex.exec(string);

        if (match) {
            config._pf.iso = true;
            for (i = 0, l = isoDates.length; i < l; i++) {
                if (isoDates[i][1].exec(string)) {
                    // match[5] should be 'T' or undefined
                    config._f = isoDates[i][0] + (match[6] || ' ');
                    break;
                }
            }
            for (i = 0, l = isoTimes.length; i < l; i++) {
                if (isoTimes[i][1].exec(string)) {
                    config._f += isoTimes[i][0];
                    break;
                }
            }
            if (string.match(parseTokenTimezone)) {
                config._f += 'Z';
            }
            makeDateFromStringAndFormat(config);
        } else {
            config._isValid = false;
        }
    }

    // date from iso format or fallback
    function makeDateFromString(config) {
        parseISO(config);
        if (config._isValid === false) {
            delete config._isValid;
            moment.createFromInputFallback(config);
        }
    }

    function map(arr, fn) {
        var res = [], i;
        for (i = 0; i < arr.length; ++i) {
            res.push(fn(arr[i], i));
        }
        return res;
    }

    function makeDateFromInput(config) {
        var input = config._i, matched;
        if (input === undefined) {
            config._d = new Date();
        } else if (isDate(input)) {
            config._d = new Date(+input);
        } else if ((matched = aspNetJsonRegex.exec(input)) !== null) {
            config._d = new Date(+matched[1]);
        } else if (typeof input === 'string') {
            makeDateFromString(config);
        } else if (isArray(input)) {
            config._a = map(input.slice(0), function (obj) {
                return parseInt(obj, 10);
            });
            dateFromConfig(config);
        } else if (typeof(input) === 'object') {
            dateFromObject(config);
        } else if (typeof(input) === 'number') {
            // from milliseconds
            config._d = new Date(input);
        } else {
            moment.createFromInputFallback(config);
        }
    }

    function makeDate(y, m, d, h, M, s, ms) {
        //can't just apply() to create a date:
        //http://stackoverflow.com/questions/181348/instantiating-a-javascript-object-by-calling-prototype-constructor-apply
        var date = new Date(y, m, d, h, M, s, ms);

        //the date constructor doesn't accept years < 1970
        if (y < 1970) {
            date.setFullYear(y);
        }
        return date;
    }

    function makeUTCDate(y) {
        var date = new Date(Date.UTC.apply(null, arguments));
        if (y < 1970) {
            date.setUTCFullYear(y);
        }
        return date;
    }

    function parseWeekday(input, locale) {
        if (typeof input === 'string') {
            if (!isNaN(input)) {
                input = parseInt(input, 10);
            }
            else {
                input = locale.weekdaysParse(input);
                if (typeof input !== 'number') {
                    return null;
                }
            }
        }
        return input;
    }

    /************************************
        Relative Time
    ************************************/


    // helper function for moment.fn.from, moment.fn.fromNow, and moment.duration.fn.humanize
    function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
        return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
    }

    function relativeTime(posNegDuration, withoutSuffix, locale) {
        var duration = moment.duration(posNegDuration).abs(),
            seconds = round(duration.as('s')),
            minutes = round(duration.as('m')),
            hours = round(duration.as('h')),
            days = round(duration.as('d')),
            months = round(duration.as('M')),
            years = round(duration.as('y')),

            args = seconds < relativeTimeThresholds.s && ['s', seconds] ||
                minutes === 1 && ['m'] ||
                minutes < relativeTimeThresholds.m && ['mm', minutes] ||
                hours === 1 && ['h'] ||
                hours < relativeTimeThresholds.h && ['hh', hours] ||
                days === 1 && ['d'] ||
                days < relativeTimeThresholds.d && ['dd', days] ||
                months === 1 && ['M'] ||
                months < relativeTimeThresholds.M && ['MM', months] ||
                years === 1 && ['y'] || ['yy', years];

        args[2] = withoutSuffix;
        args[3] = +posNegDuration > 0;
        args[4] = locale;
        return substituteTimeAgo.apply({}, args);
    }


    /************************************
        Week of Year
    ************************************/


    // firstDayOfWeek       0 = sun, 6 = sat
    //                      the day of the week that starts the week
    //                      (usually sunday or monday)
    // firstDayOfWeekOfYear 0 = sun, 6 = sat
    //                      the first week is the week that contains the first
    //                      of this day of the week
    //                      (eg. ISO weeks use thursday (4))
    function weekOfYear(mom, firstDayOfWeek, firstDayOfWeekOfYear) {
        var end = firstDayOfWeekOfYear - firstDayOfWeek,
            daysToDayOfWeek = firstDayOfWeekOfYear - mom.day(),
            adjustedMoment;


        if (daysToDayOfWeek > end) {
            daysToDayOfWeek -= 7;
        }

        if (daysToDayOfWeek < end - 7) {
            daysToDayOfWeek += 7;
        }

        adjustedMoment = moment(mom).add(daysToDayOfWeek, 'd');
        return {
            week: Math.ceil(adjustedMoment.dayOfYear() / 7),
            year: adjustedMoment.year()
        };
    }

    //http://en.wikipedia.org/wiki/ISO_week_date#Calculating_a_date_given_the_year.2C_week_number_and_weekday
    function dayOfYearFromWeeks(year, week, weekday, firstDayOfWeekOfYear, firstDayOfWeek) {
        var d = makeUTCDate(year, 0, 1).getUTCDay(), daysToAdd, dayOfYear;

        d = d === 0 ? 7 : d;
        weekday = weekday != null ? weekday : firstDayOfWeek;
        daysToAdd = firstDayOfWeek - d + (d > firstDayOfWeekOfYear ? 7 : 0) - (d < firstDayOfWeek ? 7 : 0);
        dayOfYear = 7 * (week - 1) + (weekday - firstDayOfWeek) + daysToAdd + 1;

        return {
            year: dayOfYear > 0 ? year : year - 1,
            dayOfYear: dayOfYear > 0 ?  dayOfYear : daysInYear(year - 1) + dayOfYear
        };
    }

    /************************************
        Top Level Functions
    ************************************/

    function makeMoment(config) {
        var input = config._i,
            format = config._f,
            res;

        config._locale = config._locale || moment.localeData(config._l);

        if (input === null || (format === undefined && input === '')) {
            return moment.invalid({nullInput: true});
        }

        if (typeof input === 'string') {
            config._i = input = config._locale.preparse(input);
        }

        if (moment.isMoment(input)) {
            return new Moment(input, true);
        } else if (format) {
            if (isArray(format)) {
                makeDateFromStringAndArray(config);
            } else {
                makeDateFromStringAndFormat(config);
            }
        } else {
            makeDateFromInput(config);
        }

        res = new Moment(config);
        if (res._nextDay) {
            // Adding is smart enough around DST
            res.add(1, 'd');
            res._nextDay = undefined;
        }

        return res;
    }

    moment = function (input, format, locale, strict) {
        var c;

        if (typeof(locale) === 'boolean') {
            strict = locale;
            locale = undefined;
        }
        // object construction must be done this way.
        // https://github.com/moment/moment/issues/1423
        c = {};
        c._isAMomentObject = true;
        c._i = input;
        c._f = format;
        c._l = locale;
        c._strict = strict;
        c._isUTC = false;
        c._pf = defaultParsingFlags();

        return makeMoment(c);
    };

    moment.suppressDeprecationWarnings = false;

    moment.createFromInputFallback = deprecate(
        'moment construction falls back to js Date. This is ' +
        'discouraged and will be removed in upcoming major ' +
        'release. Please refer to ' +
        'https://github.com/moment/moment/issues/1407 for more info.',
        function (config) {
            config._d = new Date(config._i + (config._useUTC ? ' UTC' : ''));
        }
    );

    // Pick a moment m from moments so that m[fn](other) is true for all
    // other. This relies on the function fn to be transitive.
    //
    // moments should either be an array of moment objects or an array, whose
    // first element is an array of moment objects.
    function pickBy(fn, moments) {
        var res, i;
        if (moments.length === 1 && isArray(moments[0])) {
            moments = moments[0];
        }
        if (!moments.length) {
            return moment();
        }
        res = moments[0];
        for (i = 1; i < moments.length; ++i) {
            if (moments[i][fn](res)) {
                res = moments[i];
            }
        }
        return res;
    }

    moment.min = function () {
        var args = [].slice.call(arguments, 0);

        return pickBy('isBefore', args);
    };

    moment.max = function () {
        var args = [].slice.call(arguments, 0);

        return pickBy('isAfter', args);
    };

    // creating with utc
    moment.utc = function (input, format, locale, strict) {
        var c;

        if (typeof(locale) === 'boolean') {
            strict = locale;
            locale = undefined;
        }
        // object construction must be done this way.
        // https://github.com/moment/moment/issues/1423
        c = {};
        c._isAMomentObject = true;
        c._useUTC = true;
        c._isUTC = true;
        c._l = locale;
        c._i = input;
        c._f = format;
        c._strict = strict;
        c._pf = defaultParsingFlags();

        return makeMoment(c).utc();
    };

    // creating with unix timestamp (in seconds)
    moment.unix = function (input) {
        return moment(input * 1000);
    };

    // duration
    moment.duration = function (input, key) {
        var duration = input,
            // matching against regexp is expensive, do it on demand
            match = null,
            sign,
            ret,
            parseIso,
            diffRes;

        if (moment.isDuration(input)) {
            duration = {
                ms: input._milliseconds,
                d: input._days,
                M: input._months
            };
        } else if (typeof input === 'number') {
            duration = {};
            if (key) {
                duration[key] = input;
            } else {
                duration.milliseconds = input;
            }
        } else if (!!(match = aspNetTimeSpanJsonRegex.exec(input))) {
            sign = (match[1] === '-') ? -1 : 1;
            duration = {
                y: 0,
                d: toInt(match[DATE]) * sign,
                h: toInt(match[HOUR]) * sign,
                m: toInt(match[MINUTE]) * sign,
                s: toInt(match[SECOND]) * sign,
                ms: toInt(match[MILLISECOND]) * sign
            };
        } else if (!!(match = isoDurationRegex.exec(input))) {
            sign = (match[1] === '-') ? -1 : 1;
            parseIso = function (inp) {
                // We'd normally use ~~inp for this, but unfortunately it also
                // converts floats to ints.
                // inp may be undefined, so careful calling replace on it.
                var res = inp && parseFloat(inp.replace(',', '.'));
                // apply sign while we're at it
                return (isNaN(res) ? 0 : res) * sign;
            };
            duration = {
                y: parseIso(match[2]),
                M: parseIso(match[3]),
                d: parseIso(match[4]),
                h: parseIso(match[5]),
                m: parseIso(match[6]),
                s: parseIso(match[7]),
                w: parseIso(match[8])
            };
        } else if (typeof duration === 'object' &&
                ('from' in duration || 'to' in duration)) {
            diffRes = momentsDifference(moment(duration.from), moment(duration.to));

            duration = {};
            duration.ms = diffRes.milliseconds;
            duration.M = diffRes.months;
        }

        ret = new Duration(duration);

        if (moment.isDuration(input) && hasOwnProp(input, '_locale')) {
            ret._locale = input._locale;
        }

        return ret;
    };

    // version number
    moment.version = VERSION;

    // default format
    moment.defaultFormat = isoFormat;

    // constant that refers to the ISO standard
    moment.ISO_8601 = function () {};

    // Plugins that add properties should also add the key here (null value),
    // so we can properly clone ourselves.
    moment.momentProperties = momentProperties;

    // This function will be called whenever a moment is mutated.
    // It is intended to keep the offset in sync with the timezone.
    moment.updateOffset = function () {};

    // This function allows you to set a threshold for relative time strings
    moment.relativeTimeThreshold = function (threshold, limit) {
        if (relativeTimeThresholds[threshold] === undefined) {
            return false;
        }
        if (limit === undefined) {
            return relativeTimeThresholds[threshold];
        }
        relativeTimeThresholds[threshold] = limit;
        return true;
    };

    moment.lang = deprecate(
        'moment.lang is deprecated. Use moment.locale instead.',
        function (key, value) {
            return moment.locale(key, value);
        }
    );

    // This function will load locale and then set the global locale.  If
    // no arguments are passed in, it will simply return the current global
    // locale key.
    moment.locale = function (key, values) {
        var data;
        if (key) {
            if (typeof(values) !== 'undefined') {
                data = moment.defineLocale(key, values);
            }
            else {
                data = moment.localeData(key);
            }

            if (data) {
                moment.duration._locale = moment._locale = data;
            }
        }

        return moment._locale._abbr;
    };

    moment.defineLocale = function (name, values) {
        if (values !== null) {
            values.abbr = name;
            if (!locales[name]) {
                locales[name] = new Locale();
            }
            locales[name].set(values);

            // backwards compat for now: also set the locale
            moment.locale(name);

            return locales[name];
        } else {
            // useful for testing
            delete locales[name];
            return null;
        }
    };

    moment.langData = deprecate(
        'moment.langData is deprecated. Use moment.localeData instead.',
        function (key) {
            return moment.localeData(key);
        }
    );

    // returns locale data
    moment.localeData = function (key) {
        var locale;

        if (key && key._locale && key._locale._abbr) {
            key = key._locale._abbr;
        }

        if (!key) {
            return moment._locale;
        }

        if (!isArray(key)) {
            //short-circuit everything else
            locale = loadLocale(key);
            if (locale) {
                return locale;
            }
            key = [key];
        }

        return chooseLocale(key);
    };

    // compare moment object
    moment.isMoment = function (obj) {
        return obj instanceof Moment ||
            (obj != null && hasOwnProp(obj, '_isAMomentObject'));
    };

    // for typechecking Duration objects
    moment.isDuration = function (obj) {
        return obj instanceof Duration;
    };

    for (i = lists.length - 1; i >= 0; --i) {
        makeList(lists[i]);
    }

    moment.normalizeUnits = function (units) {
        return normalizeUnits(units);
    };

    moment.invalid = function (flags) {
        var m = moment.utc(NaN);
        if (flags != null) {
            extend(m._pf, flags);
        }
        else {
            m._pf.userInvalidated = true;
        }

        return m;
    };

    moment.parseZone = function () {
        return moment.apply(null, arguments).parseZone();
    };

    moment.parseTwoDigitYear = function (input) {
        return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
    };

    /************************************
        Moment Prototype
    ************************************/


    extend(moment.fn = Moment.prototype, {

        clone : function () {
            return moment(this);
        },

        valueOf : function () {
            return +this._d + ((this._offset || 0) * 60000);
        },

        unix : function () {
            return Math.floor(+this / 1000);
        },

        toString : function () {
            return this.clone().locale('en').format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ');
        },

        toDate : function () {
            return this._offset ? new Date(+this) : this._d;
        },

        toISOString : function () {
            var m = moment(this).utc();
            if (0 < m.year() && m.year() <= 9999) {
                if ('function' === typeof Date.prototype.toISOString) {
                    // native implementation is ~50x faster, use it when we can
                    return this.toDate().toISOString();
                } else {
                    return formatMoment(m, 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
                }
            } else {
                return formatMoment(m, 'YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
            }
        },

        toArray : function () {
            var m = this;
            return [
                m.year(),
                m.month(),
                m.date(),
                m.hours(),
                m.minutes(),
                m.seconds(),
                m.milliseconds()
            ];
        },

        isValid : function () {
            return isValid(this);
        },

        isDSTShifted : function () {
            if (this._a) {
                return this.isValid() && compareArrays(this._a, (this._isUTC ? moment.utc(this._a) : moment(this._a)).toArray()) > 0;
            }

            return false;
        },

        parsingFlags : function () {
            return extend({}, this._pf);
        },

        invalidAt: function () {
            return this._pf.overflow;
        },

        utc : function (keepLocalTime) {
            return this.zone(0, keepLocalTime);
        },

        local : function (keepLocalTime) {
            if (this._isUTC) {
                this.zone(0, keepLocalTime);
                this._isUTC = false;

                if (keepLocalTime) {
                    this.add(this._dateTzOffset(), 'm');
                }
            }
            return this;
        },

        format : function (inputString) {
            var output = formatMoment(this, inputString || moment.defaultFormat);
            return this.localeData().postformat(output);
        },

        add : createAdder(1, 'add'),

        subtract : createAdder(-1, 'subtract'),

        diff : function (input, units, asFloat) {
            var that = makeAs(input, this),
                zoneDiff = (this.zone() - that.zone()) * 6e4,
                diff, output, daysAdjust;

            units = normalizeUnits(units);

            if (units === 'year' || units === 'month') {
                // average number of days in the months in the given dates
                diff = (this.daysInMonth() + that.daysInMonth()) * 432e5; // 24 * 60 * 60 * 1000 / 2
                // difference in months
                output = ((this.year() - that.year()) * 12) + (this.month() - that.month());
                // adjust by taking difference in days, average number of days
                // and dst in the given months.
                daysAdjust = (this - moment(this).startOf('month')) -
                    (that - moment(that).startOf('month'));
                // same as above but with zones, to negate all dst
                daysAdjust -= ((this.zone() - moment(this).startOf('month').zone()) -
                        (that.zone() - moment(that).startOf('month').zone())) * 6e4;
                output += daysAdjust / diff;
                if (units === 'year') {
                    output = output / 12;
                }
            } else {
                diff = (this - that);
                output = units === 'second' ? diff / 1e3 : // 1000
                    units === 'minute' ? diff / 6e4 : // 1000 * 60
                    units === 'hour' ? diff / 36e5 : // 1000 * 60 * 60
                    units === 'day' ? (diff - zoneDiff) / 864e5 : // 1000 * 60 * 60 * 24, negate dst
                    units === 'week' ? (diff - zoneDiff) / 6048e5 : // 1000 * 60 * 60 * 24 * 7, negate dst
                    diff;
            }
            return asFloat ? output : absRound(output);
        },

        from : function (time, withoutSuffix) {
            return moment.duration({to: this, from: time}).locale(this.locale()).humanize(!withoutSuffix);
        },

        fromNow : function (withoutSuffix) {
            return this.from(moment(), withoutSuffix);
        },

        calendar : function (time) {
            // We want to compare the start of today, vs this.
            // Getting start-of-today depends on whether we're zone'd or not.
            var now = time || moment(),
                sod = makeAs(now, this).startOf('day'),
                diff = this.diff(sod, 'days', true),
                format = diff < -6 ? 'sameElse' :
                    diff < -1 ? 'lastWeek' :
                    diff < 0 ? 'lastDay' :
                    diff < 1 ? 'sameDay' :
                    diff < 2 ? 'nextDay' :
                    diff < 7 ? 'nextWeek' : 'sameElse';
            return this.format(this.localeData().calendar(format, this, moment(now)));
        },

        isLeapYear : function () {
            return isLeapYear(this.year());
        },

        isDST : function () {
            return (this.zone() < this.clone().month(0).zone() ||
                this.zone() < this.clone().month(5).zone());
        },

        day : function (input) {
            var day = this._isUTC ? this._d.getUTCDay() : this._d.getDay();
            if (input != null) {
                input = parseWeekday(input, this.localeData());
                return this.add(input - day, 'd');
            } else {
                return day;
            }
        },

        month : makeAccessor('Month', true),

        startOf : function (units) {
            units = normalizeUnits(units);
            // the following switch intentionally omits break keywords
            // to utilize falling through the cases.
            switch (units) {
            case 'year':
                this.month(0);
                /* falls through */
            case 'quarter':
            case 'month':
                this.date(1);
                /* falls through */
            case 'week':
            case 'isoWeek':
            case 'day':
                this.hours(0);
                /* falls through */
            case 'hour':
                this.minutes(0);
                /* falls through */
            case 'minute':
                this.seconds(0);
                /* falls through */
            case 'second':
                this.milliseconds(0);
                /* falls through */
            }

            // weeks are a special case
            if (units === 'week') {
                this.weekday(0);
            } else if (units === 'isoWeek') {
                this.isoWeekday(1);
            }

            // quarters are also special
            if (units === 'quarter') {
                this.month(Math.floor(this.month() / 3) * 3);
            }

            return this;
        },

        endOf: function (units) {
            units = normalizeUnits(units);
            if (units === undefined || units === 'millisecond') {
                return this;
            }
            return this.startOf(units).add(1, (units === 'isoWeek' ? 'week' : units)).subtract(1, 'ms');
        },

        isAfter: function (input, units) {
            var inputMs;
            units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
            if (units === 'millisecond') {
                input = moment.isMoment(input) ? input : moment(input);
                return +this > +input;
            } else {
                inputMs = moment.isMoment(input) ? +input : +moment(input);
                return inputMs < +this.clone().startOf(units);
            }
        },

        isBefore: function (input, units) {
            var inputMs;
            units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
            if (units === 'millisecond') {
                input = moment.isMoment(input) ? input : moment(input);
                return +this < +input;
            } else {
                inputMs = moment.isMoment(input) ? +input : +moment(input);
                return +this.clone().endOf(units) < inputMs;
            }
        },

        isSame: function (input, units) {
            var inputMs;
            units = normalizeUnits(units || 'millisecond');
            if (units === 'millisecond') {
                input = moment.isMoment(input) ? input : moment(input);
                return +this === +input;
            } else {
                inputMs = +moment(input);
                return +(this.clone().startOf(units)) <= inputMs && inputMs <= +(this.clone().endOf(units));
            }
        },

        min: deprecate(
                 'moment().min is deprecated, use moment.min instead. https://github.com/moment/moment/issues/1548',
                 function (other) {
                     other = moment.apply(null, arguments);
                     return other < this ? this : other;
                 }
         ),

        max: deprecate(
                'moment().max is deprecated, use moment.max instead. https://github.com/moment/moment/issues/1548',
                function (other) {
                    other = moment.apply(null, arguments);
                    return other > this ? this : other;
                }
        ),

        // keepLocalTime = true means only change the timezone, without
        // affecting the local hour. So 5:31:26 +0300 --[zone(2, true)]-->
        // 5:31:26 +0200 It is possible that 5:31:26 doesn't exist int zone
        // +0200, so we adjust the time as needed, to be valid.
        //
        // Keeping the time actually adds/subtracts (one hour)
        // from the actual represented time. That is why we call updateOffset
        // a second time. In case it wants us to change the offset again
        // _changeInProgress == true case, then we have to adjust, because
        // there is no such time in the given timezone.
        zone : function (input, keepLocalTime) {
            var offset = this._offset || 0,
                localAdjust;
            if (input != null) {
                if (typeof input === 'string') {
                    input = timezoneMinutesFromString(input);
                }
                if (Math.abs(input) < 16) {
                    input = input * 60;
                }
                if (!this._isUTC && keepLocalTime) {
                    localAdjust = this._dateTzOffset();
                }
                this._offset = input;
                this._isUTC = true;
                if (localAdjust != null) {
                    this.subtract(localAdjust, 'm');
                }
                if (offset !== input) {
                    if (!keepLocalTime || this._changeInProgress) {
                        addOrSubtractDurationFromMoment(this,
                                moment.duration(offset - input, 'm'), 1, false);
                    } else if (!this._changeInProgress) {
                        this._changeInProgress = true;
                        moment.updateOffset(this, true);
                        this._changeInProgress = null;
                    }
                }
            } else {
                return this._isUTC ? offset : this._dateTzOffset();
            }
            return this;
        },

        zoneAbbr : function () {
            return this._isUTC ? 'UTC' : '';
        },

        zoneName : function () {
            return this._isUTC ? 'Coordinated Universal Time' : '';
        },

        parseZone : function () {
            if (this._tzm) {
                this.zone(this._tzm);
            } else if (typeof this._i === 'string') {
                this.zone(this._i);
            }
            return this;
        },

        hasAlignedHourOffset : function (input) {
            if (!input) {
                input = 0;
            }
            else {
                input = moment(input).zone();
            }

            return (this.zone() - input) % 60 === 0;
        },

        daysInMonth : function () {
            return daysInMonth(this.year(), this.month());
        },

        dayOfYear : function (input) {
            var dayOfYear = round((moment(this).startOf('day') - moment(this).startOf('year')) / 864e5) + 1;
            return input == null ? dayOfYear : this.add((input - dayOfYear), 'd');
        },

        quarter : function (input) {
            return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
        },

        weekYear : function (input) {
            var year = weekOfYear(this, this.localeData()._week.dow, this.localeData()._week.doy).year;
            return input == null ? year : this.add((input - year), 'y');
        },

        isoWeekYear : function (input) {
            var year = weekOfYear(this, 1, 4).year;
            return input == null ? year : this.add((input - year), 'y');
        },

        week : function (input) {
            var week = this.localeData().week(this);
            return input == null ? week : this.add((input - week) * 7, 'd');
        },

        isoWeek : function (input) {
            var week = weekOfYear(this, 1, 4).week;
            return input == null ? week : this.add((input - week) * 7, 'd');
        },

        weekday : function (input) {
            var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
            return input == null ? weekday : this.add(input - weekday, 'd');
        },

        isoWeekday : function (input) {
            // behaves the same as moment#day except
            // as a getter, returns 7 instead of 0 (1-7 range instead of 0-6)
            // as a setter, sunday should belong to the previous week.
            return input == null ? this.day() || 7 : this.day(this.day() % 7 ? input : input - 7);
        },

        isoWeeksInYear : function () {
            return weeksInYear(this.year(), 1, 4);
        },

        weeksInYear : function () {
            var weekInfo = this.localeData()._week;
            return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
        },

        get : function (units) {
            units = normalizeUnits(units);
            return this[units]();
        },

        set : function (units, value) {
            units = normalizeUnits(units);
            if (typeof this[units] === 'function') {
                this[units](value);
            }
            return this;
        },

        // If passed a locale key, it will set the locale for this
        // instance.  Otherwise, it will return the locale configuration
        // variables for this instance.
        locale : function (key) {
            var newLocaleData;

            if (key === undefined) {
                return this._locale._abbr;
            } else {
                newLocaleData = moment.localeData(key);
                if (newLocaleData != null) {
                    this._locale = newLocaleData;
                }
                return this;
            }
        },

        lang : deprecate(
            'moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.',
            function (key) {
                if (key === undefined) {
                    return this.localeData();
                } else {
                    return this.locale(key);
                }
            }
        ),

        localeData : function () {
            return this._locale;
        },

        _dateTzOffset : function () {
            // On Firefox.24 Date#getTimezoneOffset returns a floating point.
            // https://github.com/moment/moment/pull/1871
            return Math.round(this._d.getTimezoneOffset() / 15) * 15;
        }
    });

    function rawMonthSetter(mom, value) {
        var dayOfMonth;

        // TODO: Move this out of here!
        if (typeof value === 'string') {
            value = mom.localeData().monthsParse(value);
            // TODO: Another silent failure?
            if (typeof value !== 'number') {
                return mom;
            }
        }

        dayOfMonth = Math.min(mom.date(),
                daysInMonth(mom.year(), value));
        mom._d['set' + (mom._isUTC ? 'UTC' : '') + 'Month'](value, dayOfMonth);
        return mom;
    }

    function rawGetter(mom, unit) {
        return mom._d['get' + (mom._isUTC ? 'UTC' : '') + unit]();
    }

    function rawSetter(mom, unit, value) {
        if (unit === 'Month') {
            return rawMonthSetter(mom, value);
        } else {
            return mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value);
        }
    }

    function makeAccessor(unit, keepTime) {
        return function (value) {
            if (value != null) {
                rawSetter(this, unit, value);
                moment.updateOffset(this, keepTime);
                return this;
            } else {
                return rawGetter(this, unit);
            }
        };
    }

    moment.fn.millisecond = moment.fn.milliseconds = makeAccessor('Milliseconds', false);
    moment.fn.second = moment.fn.seconds = makeAccessor('Seconds', false);
    moment.fn.minute = moment.fn.minutes = makeAccessor('Minutes', false);
    // Setting the hour should keep the time, because the user explicitly
    // specified which hour he wants. So trying to maintain the same hour (in
    // a new timezone) makes sense. Adding/subtracting hours does not follow
    // this rule.
    moment.fn.hour = moment.fn.hours = makeAccessor('Hours', true);
    // moment.fn.month is defined separately
    moment.fn.date = makeAccessor('Date', true);
    moment.fn.dates = deprecate('dates accessor is deprecated. Use date instead.', makeAccessor('Date', true));
    moment.fn.year = makeAccessor('FullYear', true);
    moment.fn.years = deprecate('years accessor is deprecated. Use year instead.', makeAccessor('FullYear', true));

    // add plural methods
    moment.fn.days = moment.fn.day;
    moment.fn.months = moment.fn.month;
    moment.fn.weeks = moment.fn.week;
    moment.fn.isoWeeks = moment.fn.isoWeek;
    moment.fn.quarters = moment.fn.quarter;

    // add aliased format methods
    moment.fn.toJSON = moment.fn.toISOString;

    /************************************
        Duration Prototype
    ************************************/


    function daysToYears (days) {
        // 400 years have 146097 days (taking into account leap year rules)
        return days * 400 / 146097;
    }

    function yearsToDays (years) {
        // years * 365 + absRound(years / 4) -
        //     absRound(years / 100) + absRound(years / 400);
        return years * 146097 / 400;
    }

    extend(moment.duration.fn = Duration.prototype, {

        _bubble : function () {
            var milliseconds = this._milliseconds,
                days = this._days,
                months = this._months,
                data = this._data,
                seconds, minutes, hours, years = 0;

            // The following code bubbles up values, see the tests for
            // examples of what that means.
            data.milliseconds = milliseconds % 1000;

            seconds = absRound(milliseconds / 1000);
            data.seconds = seconds % 60;

            minutes = absRound(seconds / 60);
            data.minutes = minutes % 60;

            hours = absRound(minutes / 60);
            data.hours = hours % 24;

            days += absRound(hours / 24);

            // Accurately convert days to years, assume start from year 0.
            years = absRound(daysToYears(days));
            days -= absRound(yearsToDays(years));

            // 30 days to a month
            // TODO (iskren): Use anchor date (like 1st Jan) to compute this.
            months += absRound(days / 30);
            days %= 30;

            // 12 months -> 1 year
            years += absRound(months / 12);
            months %= 12;

            data.days = days;
            data.months = months;
            data.years = years;
        },

        abs : function () {
            this._milliseconds = Math.abs(this._milliseconds);
            this._days = Math.abs(this._days);
            this._months = Math.abs(this._months);

            this._data.milliseconds = Math.abs(this._data.milliseconds);
            this._data.seconds = Math.abs(this._data.seconds);
            this._data.minutes = Math.abs(this._data.minutes);
            this._data.hours = Math.abs(this._data.hours);
            this._data.months = Math.abs(this._data.months);
            this._data.years = Math.abs(this._data.years);

            return this;
        },

        weeks : function () {
            return absRound(this.days() / 7);
        },

        valueOf : function () {
            return this._milliseconds +
              this._days * 864e5 +
              (this._months % 12) * 2592e6 +
              toInt(this._months / 12) * 31536e6;
        },

        humanize : function (withSuffix) {
            var output = relativeTime(this, !withSuffix, this.localeData());

            if (withSuffix) {
                output = this.localeData().pastFuture(+this, output);
            }

            return this.localeData().postformat(output);
        },

        add : function (input, val) {
            // supports only 2.0-style add(1, 's') or add(moment)
            var dur = moment.duration(input, val);

            this._milliseconds += dur._milliseconds;
            this._days += dur._days;
            this._months += dur._months;

            this._bubble();

            return this;
        },

        subtract : function (input, val) {
            var dur = moment.duration(input, val);

            this._milliseconds -= dur._milliseconds;
            this._days -= dur._days;
            this._months -= dur._months;

            this._bubble();

            return this;
        },

        get : function (units) {
            units = normalizeUnits(units);
            return this[units.toLowerCase() + 's']();
        },

        as : function (units) {
            var days, months;
            units = normalizeUnits(units);

            if (units === 'month' || units === 'year') {
                days = this._days + this._milliseconds / 864e5;
                months = this._months + daysToYears(days) * 12;
                return units === 'month' ? months : months / 12;
            } else {
                // handle milliseconds separately because of floating point math errors (issue #1867)
                days = this._days + Math.round(yearsToDays(this._months / 12));
                switch (units) {
                    case 'week': return days / 7 + this._milliseconds / 6048e5;
                    case 'day': return days + this._milliseconds / 864e5;
                    case 'hour': return days * 24 + this._milliseconds / 36e5;
                    case 'minute': return days * 24 * 60 + this._milliseconds / 6e4;
                    case 'second': return days * 24 * 60 * 60 + this._milliseconds / 1000;
                    // Math.floor prevents floating point math errors here
                    case 'millisecond': return Math.floor(days * 24 * 60 * 60 * 1000) + this._milliseconds;
                    default: throw new Error('Unknown unit ' + units);
                }
            }
        },

        lang : moment.fn.lang,
        locale : moment.fn.locale,

        toIsoString : deprecate(
            'toIsoString() is deprecated. Please use toISOString() instead ' +
            '(notice the capitals)',
            function () {
                return this.toISOString();
            }
        ),

        toISOString : function () {
            // inspired by https://github.com/dordille/moment-isoduration/blob/master/moment.isoduration.js
            var years = Math.abs(this.years()),
                months = Math.abs(this.months()),
                days = Math.abs(this.days()),
                hours = Math.abs(this.hours()),
                minutes = Math.abs(this.minutes()),
                seconds = Math.abs(this.seconds() + this.milliseconds() / 1000);

            if (!this.asSeconds()) {
                // this is the same as C#'s (Noda) and python (isodate)...
                // but not other JS (goog.date)
                return 'P0D';
            }

            return (this.asSeconds() < 0 ? '-' : '') +
                'P' +
                (years ? years + 'Y' : '') +
                (months ? months + 'M' : '') +
                (days ? days + 'D' : '') +
                ((hours || minutes || seconds) ? 'T' : '') +
                (hours ? hours + 'H' : '') +
                (minutes ? minutes + 'M' : '') +
                (seconds ? seconds + 'S' : '');
        },

        localeData : function () {
            return this._locale;
        }
    });

    moment.duration.fn.toString = moment.duration.fn.toISOString;

    function makeDurationGetter(name) {
        moment.duration.fn[name] = function () {
            return this._data[name];
        };
    }

    for (i in unitMillisecondFactors) {
        if (hasOwnProp(unitMillisecondFactors, i)) {
            makeDurationGetter(i.toLowerCase());
        }
    }

    moment.duration.fn.asMilliseconds = function () {
        return this.as('ms');
    };
    moment.duration.fn.asSeconds = function () {
        return this.as('s');
    };
    moment.duration.fn.asMinutes = function () {
        return this.as('m');
    };
    moment.duration.fn.asHours = function () {
        return this.as('h');
    };
    moment.duration.fn.asDays = function () {
        return this.as('d');
    };
    moment.duration.fn.asWeeks = function () {
        return this.as('weeks');
    };
    moment.duration.fn.asMonths = function () {
        return this.as('M');
    };
    moment.duration.fn.asYears = function () {
        return this.as('y');
    };

    /************************************
        Default Locale
    ************************************/


    // Set default locale, other locale will inherit from English.
    moment.locale('en', {
        ordinalParse: /\d{1,2}(th|st|nd|rd)/,
        ordinal : function (number) {
            var b = number % 10,
                output = (toInt(number % 100 / 10) === 1) ? 'th' :
                (b === 1) ? 'st' :
                (b === 2) ? 'nd' :
                (b === 3) ? 'rd' : 'th';
            return number + output;
        }
    });

    /* EMBED_LOCALES */

    /************************************
        Exposing Moment
    ************************************/

    function makeGlobal(shouldDeprecate) {
        /*global ender:false */
        if (typeof ender !== 'undefined') {
            return;
        }
        oldGlobalMoment = globalScope.moment;
        if (shouldDeprecate) {
            globalScope.moment = deprecate(
                    'Accessing Moment through the global scope is ' +
                    'deprecated, and will be removed in an upcoming ' +
                    'release.',
                    moment);
        } else {
            globalScope.moment = moment;
        }
    }

    // CommonJS module is defined
    if (hasModule) {
        module.exports = moment;
    } else if (typeof define === 'function' && define.amd) {
        define('moment', ['require','exports','module'],function (require, exports, module) {
            if (module.config && module.config() && module.config().noGlobal === true) {
                // release the global variable
                globalScope.moment = oldGlobalMoment;
            }

            return moment;
        });
        makeGlobal(true);
    } else {
        makeGlobal();
    }
}).call(this);


// 'codemirror/addon/edit/matchbrackets'
(function(mod) {
    mod(CodeMirror)
})(function (CodeMirror) {
    var ie_lt8 = /MSIE \d/.test(navigator.userAgent) &&
      (document.documentMode == null || document.documentMode < 8);
  
    var Pos = CodeMirror.Pos;
  
    var matching = {"(": ")>", ")": "(<", "[": "]>", "]": "[<", "{": "}>", "}": "{<"};
  
    function findMatchingBracket(cm, where, strict, config) {
      var line = cm.getLineHandle(where.line), pos = where.ch - 1;
      var match = (pos >= 0 && matching[line.text.charAt(pos)]) || matching[line.text.charAt(++pos)];
      if (!match) return null;
      var dir = match.charAt(1) == ">" ? 1 : -1;
      if (strict && (dir > 0) != (pos == where.ch)) return null;
      var style = cm.getTokenTypeAt(Pos(where.line, pos + 1));
  
      var found = scanForBracket(cm, Pos(where.line, pos + (dir > 0 ? 1 : 0)), dir, style || null, config);
      if (found == null) return null;
      return {from: Pos(where.line, pos), to: found && found.pos,
              match: found && found.ch == match.charAt(0), forward: dir > 0};
    }
  
    // bracketRegex is used to specify which type of bracket to scan
    // should be a regexp, e.g. /[[\]]/
    //
    // Note: If "where" is on an open bracket, then this bracket is ignored.
    //
    // Returns false when no bracket was found, null when it reached
    // maxScanLines and gave up
    function scanForBracket(cm, where, dir, style, config) {
      var maxScanLen = (config && config.maxScanLineLength) || 10000;
      var maxScanLines = (config && config.maxScanLines) || 1000;
  
      var stack = [];
      var re = config && config.bracketRegex ? config.bracketRegex : /[(){}[\]]/;
      var lineEnd = dir > 0 ? Math.min(where.line + maxScanLines, cm.lastLine() + 1)
                            : Math.max(cm.firstLine() - 1, where.line - maxScanLines);
      for (var lineNo = where.line; lineNo != lineEnd; lineNo += dir) {
        var line = cm.getLine(lineNo);
        if (!line) continue;
        var pos = dir > 0 ? 0 : line.length - 1, end = dir > 0 ? line.length : -1;
        if (line.length > maxScanLen) continue;
        if (lineNo == where.line) pos = where.ch - (dir < 0 ? 1 : 0);
        for (; pos != end; pos += dir) {
          var ch = line.charAt(pos);
          if (re.test(ch) && (style === undefined || cm.getTokenTypeAt(Pos(lineNo, pos + 1)) == style)) {
            var match = matching[ch];
            if ((match.charAt(1) == ">") == (dir > 0)) stack.push(ch);
            else if (!stack.length) return {pos: Pos(lineNo, pos), ch: ch};
            else stack.pop();
          }
        }
      }
      return lineNo - dir == (dir > 0 ? cm.lastLine() : cm.firstLine()) ? false : null;
    }
  
    function matchBrackets(cm, autoclear, config) {
      // Disable brace matching in long lines, since it'll cause hugely slow updates
      var maxHighlightLen = cm.state.matchBrackets.maxHighlightLineLength || 1000;
      var marks = [], ranges = cm.listSelections();
      for (var i = 0; i < ranges.length; i++) {
        var match = ranges[i].empty() && findMatchingBracket(cm, ranges[i].head, false, config);
        if (match && cm.getLine(match.from.line).length <= maxHighlightLen) {
          var style = match.match ? "CodeMirror-matchingbracket" : "CodeMirror-nonmatchingbracket";
          marks.push(cm.markText(match.from, Pos(match.from.line, match.from.ch + 1), {className: style}));
          if (match.to && cm.getLine(match.to.line).length <= maxHighlightLen)
            marks.push(cm.markText(match.to, Pos(match.to.line, match.to.ch + 1), {className: style}));
        }
      }
  
      if (marks.length) {
        // Kludge to work around the IE bug from issue #1193, where text
        // input stops going to the textare whever this fires.
        if (ie_lt8 && cm.state.focused) cm.focus();
  
        var clear = function() {
          cm.operation(function() {
            for (var i = 0; i < marks.length; i++) marks[i].clear();
          });
        };
        if (autoclear) setTimeout(clear, 800);
        else return clear;
      }
    }
  
    var currentlyHighlighted = null;
    function doMatchBrackets(cm) {
      cm.operation(function() {
        if (currentlyHighlighted) {currentlyHighlighted(); currentlyHighlighted = null;}
        currentlyHighlighted = matchBrackets(cm, false, cm.state.matchBrackets);
      });
    }
  
    CodeMirror.defineOption("matchBrackets", false, function(cm, val, old) {
      if (old && old != CodeMirror.Init)
        cm.off("cursorActivity", doMatchBrackets);
      if (val) {
        cm.state.matchBrackets = typeof val == "object" ? val : {};
        cm.on("cursorActivity", doMatchBrackets);
      }
    });
  
    CodeMirror.defineExtension("matchBrackets", function() {matchBrackets(this, true);});
    CodeMirror.defineExtension("findMatchingBracket", function(pos, strict, config){
      return findMatchingBracket(this, pos, strict, config);
    });
    CodeMirror.defineExtension("scanForBracket", function(pos, dir, style, config){
      return scanForBracket(this, pos, dir, style, config);
    });
});

// 'codemirror/addon/edit/closebrackets'
(function(mod) {
    mod(CodeMirror);
})(function (CodeMirror) {
    var defaults = {
      pairs: "()[]{}''\"\"",
      triples: "",
      explode: "[]{}"
    };
  
    var Pos = CodeMirror.Pos;
  
    CodeMirror.defineOption("autoCloseBrackets", false, function(cm, val, old) {
      if (old && old != CodeMirror.Init) {
        cm.removeKeyMap(keyMap);
        cm.state.closeBrackets = null;
      }
      if (val) {
        cm.state.closeBrackets = val;
        cm.addKeyMap(keyMap);
      }
    });
  
    function getOption(conf, name) {
      if (name == "pairs" && typeof conf == "string") return conf;
      if (typeof conf == "object" && conf[name] != null) return conf[name];
      return defaults[name];
    }
  
    var bind = defaults.pairs + "`";
    var keyMap = {Backspace: handleBackspace, Enter: handleEnter};
    for (var i = 0; i < bind.length; i++)
      keyMap["'" + bind.charAt(i) + "'"] = handler(bind.charAt(i));
  
    function handler(ch) {
      return function(cm) { return handleChar(cm, ch); };
    }
  
    function getConfig(cm) {
      var deflt = cm.state.closeBrackets;
      if (!deflt) return null;
      var mode = cm.getModeAt(cm.getCursor());
      return mode.closeBrackets || deflt;
    }
  
    function handleBackspace(cm) {
      var conf = getConfig(cm);
      if (!conf || cm.getOption("disableInput")) return CodeMirror.Pass;
  
      var pairs = getOption(conf, "pairs");
      var ranges = cm.listSelections();
      for (var i = 0; i < ranges.length; i++) {
        if (!ranges[i].empty()) return CodeMirror.Pass;
        var around = charsAround(cm, ranges[i].head);
        if (!around || pairs.indexOf(around) % 2 != 0) return CodeMirror.Pass;
      }
      for (var i = ranges.length - 1; i >= 0; i--) {
        var cur = ranges[i].head;
        cm.replaceRange("", Pos(cur.line, cur.ch - 1), Pos(cur.line, cur.ch + 1));
      }
    }
  
    function handleEnter(cm) {
      var conf = getConfig(cm);
      var explode = conf && getOption(conf, "explode");
      if (!explode || cm.getOption("disableInput")) return CodeMirror.Pass;
  
      var ranges = cm.listSelections();
      for (var i = 0; i < ranges.length; i++) {
        if (!ranges[i].empty()) return CodeMirror.Pass;
        var around = charsAround(cm, ranges[i].head);
        if (!around || explode.indexOf(around) % 2 != 0) return CodeMirror.Pass;
      }
      cm.operation(function() {
        cm.replaceSelection("\n\n", null);
        cm.execCommand("goCharLeft");
        ranges = cm.listSelections();
        for (var i = 0; i < ranges.length; i++) {
          var line = ranges[i].head.line;
          cm.indentLine(line, null, true);
          cm.indentLine(line + 1, null, true);
        }
      });
    }
  
    function handleChar(cm, ch) {
      var conf = getConfig(cm);
      if (!conf || cm.getOption("disableInput")) return CodeMirror.Pass;
  
      var pairs = getOption(conf, "pairs");
      var pos = pairs.indexOf(ch);
      if (pos == -1) return CodeMirror.Pass;
      var triples = getOption(conf, "triples");
  
      var identical = pairs.charAt(pos + 1) == ch;
      var ranges = cm.listSelections();
      var opening = pos % 2 == 0;
  
      var type, next;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i], cur = range.head, curType;
        var next = cm.getRange(cur, Pos(cur.line, cur.ch + 1));
        if (opening && !range.empty()) {
          curType = "surround";
        } else if ((identical || !opening) && next == ch) {
          if (triples.indexOf(ch) >= 0 && cm.getRange(cur, Pos(cur.line, cur.ch + 3)) == ch + ch + ch)
            curType = "skipThree";
          else
            curType = "skip";
        } else if (identical && cur.ch > 1 && triples.indexOf(ch) >= 0 &&
                   cm.getRange(Pos(cur.line, cur.ch - 2), cur) == ch + ch &&
                   (cur.ch <= 2 || cm.getRange(Pos(cur.line, cur.ch - 3), Pos(cur.line, cur.ch - 2)) != ch)) {
          curType = "addFour";
        } else if (identical) {
          if (!CodeMirror.isWordChar(next) && enteringString(cm, cur, ch)) curType = "both";
          else return CodeMirror.Pass;
        } else if (opening && (cm.getLine(cur.line).length == cur.ch ||
                               isClosingBracket(next, pairs) ||
                               /\s/.test(next))) {
          curType = "both";
        } else {
          return CodeMirror.Pass;
        }
        if (!type) type = curType;
        else if (type != curType) return CodeMirror.Pass;
      }
  
      var left = pos % 2 ? pairs.charAt(pos - 1) : ch;
      var right = pos % 2 ? ch : pairs.charAt(pos + 1);
      cm.operation(function() {
        if (type == "skip") {
          cm.execCommand("goCharRight");
        } else if (type == "skipThree") {
          for (var i = 0; i < 3; i++)
            cm.execCommand("goCharRight");
        } else if (type == "surround") {
          var sels = cm.getSelections();
          for (var i = 0; i < sels.length; i++)
            sels[i] = left + sels[i] + right;
          cm.replaceSelections(sels, "around");
        } else if (type == "both") {
          cm.replaceSelection(left + right, null);
          cm.triggerElectric(left + right);
          cm.execCommand("goCharLeft");
        } else if (type == "addFour") {
          cm.replaceSelection(left + left + left + left, "before");
          cm.execCommand("goCharRight");
        }
      });
    }
  
    function isClosingBracket(ch, pairs) {
      var pos = pairs.lastIndexOf(ch);
      return pos > -1 && pos % 2 == 1;
    }
  
    function charsAround(cm, pos) {
      var str = cm.getRange(Pos(pos.line, pos.ch - 1),
                            Pos(pos.line, pos.ch + 1));
      return str.length == 2 ? str : null;
    }
  
    // Project the token type that will exists after the given char is
    // typed, and use it to determine whether it would cause the start
    // of a string token.
    function enteringString(cm, pos, ch) {
      var line = cm.getLine(pos.line);
      var token = cm.getTokenAt(pos);
      if (/\bstring2?\b/.test(token.type)) return false;
      var stream = new CodeMirror.StringStream(line.slice(0, pos.ch) + ch + line.slice(pos.ch), 4);
      stream.pos = stream.start = token.start;
      for (;;) {
        var type1 = cm.getMode().token(stream, token.state);
        if (stream.pos >= pos.ch + 1) return /\bstring2?\b/.test(type1);
        stream.start = stream.pos;
      }
    }
});

// 'codemirror/addon/comment/comment'
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";
  
    var noOptions = {};
    var nonWS = /[^\s\u00a0]/;
    var Pos = CodeMirror.Pos;
  
    function firstNonWS(str) {
      var found = str.search(nonWS);
      return found == -1 ? 0 : found;
    }
  
    CodeMirror.commands.toggleComment = function(cm) {
      var minLine = Infinity, ranges = cm.listSelections(), mode = null;
      for (var i = ranges.length - 1; i >= 0; i--) {
        var from = ranges[i].from(), to = ranges[i].to();
        if (from.line >= minLine) continue;
        if (to.line >= minLine) to = Pos(minLine, 0);
        minLine = from.line;
        if (mode == null) {
          if (cm.uncomment(from, to)) mode = "un";
          else { cm.lineComment(from, to); mode = "line"; }
        } else if (mode == "un") {
          cm.uncomment(from, to);
        } else {
          cm.lineComment(from, to);
        }
      }
    };
  
    CodeMirror.defineExtension("lineComment", function(from, to, options) {
      if (!options) options = noOptions;
      var self = this, mode = self.getModeAt(from);
      var commentString = options.lineComment || mode.lineComment;
      if (!commentString) {
        if (options.blockCommentStart || mode.blockCommentStart) {
          options.fullLines = true;
          self.blockComment(from, to, options);
        }
        return;
      }
      var firstLine = self.getLine(from.line);
      if (firstLine == null) return;
      var end = Math.min(to.ch != 0 || to.line == from.line ? to.line + 1 : to.line, self.lastLine() + 1);
      var pad = options.padding == null ? " " : options.padding;
      var blankLines = options.commentBlankLines || from.line == to.line;
  
      self.operation(function() {
        if (options.indent) {
          var baseString = firstLine.slice(0, firstNonWS(firstLine));
          for (var i = from.line; i < end; ++i) {
            var line = self.getLine(i), cut = baseString.length;
            if (!blankLines && !nonWS.test(line)) continue;
            if (line.slice(0, cut) != baseString) cut = firstNonWS(line);
            self.replaceRange(baseString + commentString + pad, Pos(i, 0), Pos(i, cut));
          }
        } else {
          for (var i = from.line; i < end; ++i) {
            if (blankLines || nonWS.test(self.getLine(i)))
              self.replaceRange(commentString + pad, Pos(i, 0));
          }
        }
      });
    });
  
    CodeMirror.defineExtension("blockComment", function(from, to, options) {
      if (!options) options = noOptions;
      var self = this, mode = self.getModeAt(from);
      var startString = options.blockCommentStart || mode.blockCommentStart;
      var endString = options.blockCommentEnd || mode.blockCommentEnd;
      if (!startString || !endString) {
        if ((options.lineComment || mode.lineComment) && options.fullLines != false)
          self.lineComment(from, to, options);
        return;
      }
  
      var end = Math.min(to.line, self.lastLine());
      if (end != from.line && to.ch == 0 && nonWS.test(self.getLine(end))) --end;
  
      var pad = options.padding == null ? " " : options.padding;
      if (from.line > end) return;
  
      self.operation(function() {
        if (options.fullLines != false) {
          var lastLineHasText = nonWS.test(self.getLine(end));
          self.replaceRange(pad + endString, Pos(end));
          self.replaceRange(startString + pad, Pos(from.line, 0));
          var lead = options.blockCommentLead || mode.blockCommentLead;
          if (lead != null) for (var i = from.line + 1; i <= end; ++i)
            if (i != end || lastLineHasText)
              self.replaceRange(lead + pad, Pos(i, 0));
        } else {
          self.replaceRange(endString, to);
          self.replaceRange(startString, from);
        }
      });
    });
  
    CodeMirror.defineExtension("uncomment", function(from, to, options) {
      if (!options) options = noOptions;
      var self = this, mode = self.getModeAt(from);
      var end = Math.min(to.ch != 0 || to.line == from.line ? to.line : to.line - 1, self.lastLine()), start = Math.min(from.line, end);
  
      // Try finding line comments
      var lineString = options.lineComment || mode.lineComment, lines = [];
      var pad = options.padding == null ? " " : options.padding, didSomething;
      lineComment: {
        if (!lineString) break lineComment;
        for (var i = start; i <= end; ++i) {
          var line = self.getLine(i);
          var found = line.indexOf(lineString);
          if (found > -1 && !/comment/.test(self.getTokenTypeAt(Pos(i, found + 1)))) found = -1;
          if (found == -1 && (i != end || i == start) && nonWS.test(line)) break lineComment;
          if (found > -1 && nonWS.test(line.slice(0, found))) break lineComment;
          lines.push(line);
        }
        self.operation(function() {
          for (var i = start; i <= end; ++i) {
            var line = lines[i - start];
            var pos = line.indexOf(lineString), endPos = pos + lineString.length;
            if (pos < 0) continue;
            if (line.slice(endPos, endPos + pad.length) == pad) endPos += pad.length;
            didSomething = true;
            self.replaceRange("", Pos(i, pos), Pos(i, endPos));
          }
        });
        if (didSomething) return true;
      }
  
      // Try block comments
      var startString = options.blockCommentStart || mode.blockCommentStart;
      var endString = options.blockCommentEnd || mode.blockCommentEnd;
      if (!startString || !endString) return false;
      var lead = options.blockCommentLead || mode.blockCommentLead;
      var startLine = self.getLine(start), endLine = end == start ? startLine : self.getLine(end);
      var open = startLine.indexOf(startString), close = endLine.lastIndexOf(endString);
      if (close == -1 && start != end) {
        endLine = self.getLine(--end);
        close = endLine.lastIndexOf(endString);
      }
      if (open == -1 || close == -1 ||
          !/comment/.test(self.getTokenTypeAt(Pos(start, open + 1))) ||
          !/comment/.test(self.getTokenTypeAt(Pos(end, close + 1))))
        return false;
  
      // Avoid killing block comments completely outside the selection.
      // Positions of the last startString before the start of the selection, and the first endString after it.
      var lastStart = startLine.lastIndexOf(startString, from.ch);
      var firstEnd = lastStart == -1 ? -1 : startLine.slice(0, from.ch).indexOf(endString, lastStart + startString.length);
      if (lastStart != -1 && firstEnd != -1 && firstEnd + endString.length != from.ch) return false;
      // Positions of the first endString after the end of the selection, and the last startString before it.
      firstEnd = endLine.indexOf(endString, to.ch);
      var almostLastStart = endLine.slice(to.ch).lastIndexOf(startString, firstEnd - to.ch);
      lastStart = (firstEnd == -1 || almostLastStart == -1) ? -1 : to.ch + almostLastStart;
      if (firstEnd != -1 && lastStart != -1 && lastStart != to.ch) return false;
  
      self.operation(function() {
        self.replaceRange("", Pos(end, close - (pad && endLine.slice(close - pad.length, close) == pad ? pad.length : 0)),
                          Pos(end, close + endString.length));
        var openEnd = open + startString.length;
        if (pad && startLine.slice(openEnd, openEnd + pad.length) == pad) openEnd += pad.length;
        self.replaceRange("", Pos(start, open), Pos(start, openEnd));
        if (lead) for (var i = start + 1; i <= end; ++i) {
          var line = self.getLine(i), found = line.indexOf(lead);
          if (found == -1 || nonWS.test(line.slice(0, found))) continue;
          var foundEnd = found + lead.length;
          if (pad && line.slice(foundEnd, foundEnd + pad.length) == pad) foundEnd += pad.length;
          self.replaceRange("", Pos(i, found), Pos(i, foundEnd));
        }
      });
      return true;
    });
});

// codemirror/mode/meta
(function(mod) {
    mod(CodeMirror)
})(function (CodeMirror) {
    "use strict";
  
    CodeMirror.modeInfo = [
      {name: "APL", mime: "text/apl", mode: "apl", ext: ["dyalog", "apl"]},
      {name: "PGP", mimes: ["application/pgp", "application/pgp-keys", "application/pgp-signature"], mode: "asciiarmor", ext: ["pgp"]},
      {name: "ASN.1", mime: "text/x-ttcn-asn", mode: "asn.1", ext: ["asn", "asn1"]},
      {name: "Asterisk", mime: "text/x-asterisk", mode: "asterisk", file: /^extensions\.conf$/i},
      {name: "Brainfuck", mime: "text/x-brainfuck", mode: "brainfuck", ext: ["b", "bf"]},
      {name: "C", mime: "text/x-csrc", mode: "clike", ext: ["c", "h"]},
      {name: "C++", mime: "text/x-c++src", mode: "clike", ext: ["cpp", "c++", "cc", "cxx", "hpp", "h++", "hh", "hxx"], alias: ["cpp"]},
      {name: "Cobol", mime: "text/x-cobol", mode: "cobol", ext: ["cob", "cpy"]},
      {name: "C#", mime: "text/x-csharp", mode: "clike", ext: ["cs"], alias: ["csharp"]},
      {name: "Clojure", mime: "text/x-clojure", mode: "clojure", ext: ["clj"]},
      {name: "CMake", mime: "text/x-cmake", mode: "cmake", ext: ["cmake", "cmake.in"], file: /^CMakeLists.txt$/},
      {name: "CoffeeScript", mime: "text/x-coffeescript", mode: "coffeescript", ext: ["coffee"], alias: ["coffee", "coffee-script"]},
      {name: "Common Lisp", mime: "text/x-common-lisp", mode: "commonlisp", ext: ["cl", "lisp", "el"], alias: ["lisp"]},
      {name: "Cypher", mime: "application/x-cypher-query", mode: "cypher", ext: ["cyp", "cypher"]},
      {name: "Cython", mime: "text/x-cython", mode: "python", ext: ["pyx", "pxd", "pxi"]},
      {name: "CSS", mime: "text/css", mode: "css", ext: ["css"]},
      {name: "CQL", mime: "text/x-cassandra", mode: "sql", ext: ["cql"]},
      {name: "D", mime: "text/x-d", mode: "d", ext: ["d"]},
      {name: "Dart", mimes: ["application/dart", "text/x-dart"], mode: "dart", ext: ["dart"]},
      {name: "diff", mime: "text/x-diff", mode: "diff", ext: ["diff", "patch"]},
      {name: "Django", mime: "text/x-django", mode: "django"},
      {name: "Dockerfile", mime: "text/x-dockerfile", mode: "dockerfile", file: /^Dockerfile$/},
      {name: "DTD", mime: "application/xml-dtd", mode: "dtd", ext: ["dtd"]},
      {name: "Dylan", mime: "text/x-dylan", mode: "dylan", ext: ["dylan", "dyl", "intr"]},
      {name: "EBNF", mime: "text/x-ebnf", mode: "ebnf"},
      {name: "ECL", mime: "text/x-ecl", mode: "ecl", ext: ["ecl"]},
      {name: "Eiffel", mime: "text/x-eiffel", mode: "eiffel", ext: ["e"]},
      {name: "Elm", mime: "text/x-elm", mode: "elm", ext: ["elm"]},
      {name: "Embedded Javascript", mime: "application/x-ejs", mode: "htmlembedded", ext: ["ejs"]},
      {name: "Embedded Ruby", mime: "application/x-erb", mode: "htmlembedded", ext: ["erb"]},
      {name: "Erlang", mime: "text/x-erlang", mode: "erlang", ext: ["erl"]},
      {name: "Factor", mime: "text/x-factor", mode: "factor", ext: ["factor"]},
      {name: "Forth", mime: "text/x-forth", mode: "forth", ext: ["forth", "fth", "4th"]},
      {name: "Fortran", mime: "text/x-fortran", mode: "fortran", ext: ["f", "for", "f77", "f90"]},
      {name: "F#", mime: "text/x-fsharp", mode: "mllike", ext: ["fs"], alias: ["fsharp"]},
      {name: "Gas", mime: "text/x-gas", mode: "gas", ext: ["s"]},
      {name: "Gherkin", mime: "text/x-feature", mode: "gherkin", ext: ["feature"]},
      {name: "GitHub Flavored Markdown", mime: "text/x-gfm", mode: "gfm", file: /^(readme|contributing|history).md$/i},
      {name: "Go", mime: "text/x-go", mode: "go", ext: ["go"]},
      {name: "Groovy", mime: "text/x-groovy", mode: "groovy", ext: ["groovy"]},
      {name: "HAML", mime: "text/x-haml", mode: "haml", ext: ["haml"]},
      {name: "Haskell", mime: "text/x-haskell", mode: "haskell", ext: ["hs"]},
      {name: "Haxe", mime: "text/x-haxe", mode: "haxe", ext: ["hx"]},
      {name: "HXML", mime: "text/x-hxml", mode: "haxe", ext: ["hxml"]},
      {name: "ASP.NET", mime: "application/x-aspx", mode: "htmlembedded", ext: ["aspx"], alias: ["asp", "aspx"]},
      {name: "HTML", mime: "text/html", mode: "htmlmixed", ext: ["html", "htm"], alias: ["xhtml"]},
      {name: "HTTP", mime: "message/http", mode: "http"},
      {name: "IDL", mime: "text/x-idl", mode: "idl", ext: ["pro"]},
      {name: "Jade", mime: "text/x-jade", mode: "jade", ext: ["jade"]},
      {name: "Java", mime: "text/x-java", mode: "clike", ext: ["java"]},
      {name: "Java Server Pages", mime: "application/x-jsp", mode: "htmlembedded", ext: ["jsp"], alias: ["jsp"]},
      {name: "JavaScript", mimes: ["text/javascript", "text/ecmascript", "application/javascript", "application/x-javascript", "application/ecmascript"],
       mode: "javascript", ext: ["js"], alias: ["ecmascript", "js", "node"]},
      {name: "JSON", mimes: ["application/json", "application/x-json"], mode: "javascript", ext: ["json", "map"], alias: ["json5"]},
      {name: "JSON-LD", mime: "application/ld+json", mode: "javascript", ext: ["jsonld"], alias: ["jsonld"]},
      {name: "Jinja2", mime: "null", mode: "jinja2"},
      {name: "Julia", mime: "text/x-julia", mode: "julia", ext: ["jl"]},
      {name: "Kotlin", mime: "text/x-kotlin", mode: "kotlin", ext: ["kt"]},
      {name: "LESS", mime: "text/x-less", mode: "css", ext: ["less"]},
      {name: "LiveScript", mime: "text/x-livescript", mode: "livescript", ext: ["ls"], alias: ["ls"]},
      {name: "Lua", mime: "text/x-lua", mode: "lua", ext: ["lua"]},
      {name: "Markdown", mime: "text/x-markdown", mode: "markdown", ext: ["markdown", "md", "mkd"]},
      {name: "mIRC", mime: "text/mirc", mode: "mirc"},
      {name: "MariaDB SQL", mime: "text/x-mariadb", mode: "sql"},
      {name: "Mathematica", mime: "text/x-mathematica", mode: "mathematica", ext: ["m", "nb"]},
      {name: "Modelica", mime: "text/x-modelica", mode: "modelica", ext: ["mo"]},
      {name: "MUMPS", mime: "text/x-mumps", mode: "mumps"},
      {name: "MS SQL", mime: "text/x-mssql", mode: "sql"},
      {name: "MySQL", mime: "text/x-mysql", mode: "sql"},
      {name: "Nginx", mime: "text/x-nginx-conf", mode: "nginx", file: /nginx.*\.conf$/i},
      {name: "NTriples", mime: "text/n-triples", mode: "ntriples", ext: ["nt"]},
      {name: "Objective C", mime: "text/x-objectivec", mode: "clike", ext: ["m", "mm"]},
      {name: "OCaml", mime: "text/x-ocaml", mode: "mllike", ext: ["ml", "mli", "mll", "mly"]},
      {name: "Octave", mime: "text/x-octave", mode: "octave", ext: ["m"]},
      {name: "Pascal", mime: "text/x-pascal", mode: "pascal", ext: ["p", "pas"]},
      {name: "PEG.js", mime: "null", mode: "pegjs", ext: ["jsonld"]},
      {name: "Perl", mime: "text/x-perl", mode: "perl", ext: ["pl", "pm"]},
      {name: "PHP", mime: "application/x-httpd-php", mode: "php", ext: ["php", "php3", "php4", "php5", "phtml"]},
      {name: "Pig", mime: "text/x-pig", mode: "pig", ext: ["pig"]},
      {name: "Plain Text", mime: "text/plain", mode: "null", ext: ["txt", "text", "conf", "def", "list", "log"]},
      {name: "PLSQL", mime: "text/x-plsql", mode: "sql", ext: ["pls"]},
      {name: "Properties files", mime: "text/x-properties", mode: "properties", ext: ["properties", "ini", "in"], alias: ["ini", "properties"]},
      {name: "Python", mime: "text/x-python", mode: "python", ext: ["py", "pyw"]},
      {name: "Puppet", mime: "text/x-puppet", mode: "puppet", ext: ["pp"]},
      {name: "Q", mime: "text/x-q", mode: "q", ext: ["q"]},
      {name: "R", mime: "text/x-rsrc", mode: "r", ext: ["r"], alias: ["rscript"]},
      {name: "reStructuredText", mime: "text/x-rst", mode: "rst", ext: ["rst"], alias: ["rst"]},
      {name: "RPM Changes", mime: "text/x-rpm-changes", mode: "rpm"},
      {name: "RPM Spec", mime: "text/x-rpm-spec", mode: "rpm", ext: ["spec"]},
      {name: "Ruby", mime: "text/x-ruby", mode: "ruby", ext: ["rb"], alias: ["jruby", "macruby", "rake", "rb", "rbx"]},
      {name: "Rust", mime: "text/x-rustsrc", mode: "rust", ext: ["rs"]},
      {name: "Sass", mime: "text/x-sass", mode: "sass", ext: ["sass"]},
      {name: "Scala", mime: "text/x-scala", mode: "clike", ext: ["scala"]},
      {name: "Scheme", mime: "text/x-scheme", mode: "scheme", ext: ["scm", "ss"]},
      {name: "SCSS", mime: "text/x-scss", mode: "css", ext: ["scss"]},
      {name: "Shell", mime: "text/x-sh", mode: "shell", ext: ["sh", "ksh", "bash"], alias: ["bash", "sh", "zsh"]},
      {name: "Sieve", mime: "application/sieve", mode: "sieve", ext: ["siv", "sieve"]},
      {name: "Slim", mimes: ["text/x-slim", "application/x-slim"], mode: "slim", ext: ["slim"]},
      {name: "Smalltalk", mime: "text/x-stsrc", mode: "smalltalk", ext: ["st"]},
      {name: "Smarty", mime: "text/x-smarty", mode: "smarty", ext: ["tpl"]},
      {name: "Solr", mime: "text/x-solr", mode: "solr"},
      {name: "Soy", mime: "text/x-soy", mode: "soy", ext: ["soy"], alias: ["closure template"]},
      {name: "SPARQL", mime: "application/sparql-query", mode: "sparql", ext: ["rq", "sparql"], alias: ["sparul"]},
      {name: "Spreadsheet", mime: "text/x-spreadsheet", mode: "spreadsheet", alias: ["excel", "formula"]},
      {name: "SQL", mime: "text/x-sql", mode: "sql", ext: ["sql"]},
      {name: "Squirrel", mime: "text/x-squirrel", mode: "clike", ext: ["nut"]},
      {name: "Swift", mime: "text/x-swift", mode: "swift", ext: ["swift"]},
      {name: "MariaDB", mime: "text/x-mariadb", mode: "sql"},
      {name: "sTeX", mime: "text/x-stex", mode: "stex"},
      {name: "LaTeX", mime: "text/x-latex", mode: "stex", ext: ["text", "ltx"], alias: ["tex"]},
      {name: "SystemVerilog", mime: "text/x-systemverilog", mode: "verilog", ext: ["v"]},
      {name: "Tcl", mime: "text/x-tcl", mode: "tcl", ext: ["tcl"]},
      {name: "Textile", mime: "text/x-textile", mode: "textile", ext: ["textile"]},
      {name: "TiddlyWiki ", mime: "text/x-tiddlywiki", mode: "tiddlywiki"},
      {name: "Tiki wiki", mime: "text/tiki", mode: "tiki"},
      {name: "TOML", mime: "text/x-toml", mode: "toml", ext: ["toml"]},
      {name: "Tornado", mime: "text/x-tornado", mode: "tornado"},
      {name: "troff", mime: "troff", mode: "troff", ext: ["1", "2", "3", "4", "5", "6", "7", "8", "9"]},
      {name: "TTCN", mime: "text/x-ttcn", mode: "ttcn", ext: ["ttcn", "ttcn3", "ttcnpp"]},
      {name: "TTCN_CFG", mime: "text/x-ttcn-cfg", mode: "ttcn-cfg", ext: ["cfg"]},
      {name: "Turtle", mime: "text/turtle", mode: "turtle", ext: ["ttl"]},
      {name: "TypeScript", mime: "application/typescript", mode: "javascript", ext: ["ts"], alias: ["ts"]},
      {name: "Twig", mime: "text/x-twig", mode: "twig"},
      {name: "VB.NET", mime: "text/x-vb", mode: "vb", ext: ["vb"]},
      {name: "VBScript", mime: "text/vbscript", mode: "vbscript", ext: ["vbs"]},
      {name: "Velocity", mime: "text/velocity", mode: "velocity", ext: ["vtl"]},
      {name: "Verilog", mime: "text/x-verilog", mode: "verilog", ext: ["v"]},
      {name: "XML", mimes: ["application/xml", "text/xml"], mode: "xml", ext: ["xml", "xsl", "xsd"], alias: ["rss", "wsdl", "xsd"]},
      {name: "XQuery", mime: "application/xquery", mode: "xquery", ext: ["xy", "xquery"]},
      {name: "YAML", mime: "text/x-yaml", mode: "yaml", ext: ["yaml", "yml"], alias: ["yml"]},
      {name: "Z80", mime: "text/x-z80", mode: "z80", ext: ["z80"]}
    ];
    // Ensure all modes have a mime property for backwards compatibility
    for (var i = 0; i < CodeMirror.modeInfo.length; i++) {
      var info = CodeMirror.modeInfo[i];
      if (info.mimes) info.mime = info.mimes[0];
    }
  
    CodeMirror.findModeByMIME = function(mime) {
      mime = mime.toLowerCase();
      for (var i = 0; i < CodeMirror.modeInfo.length; i++) {
        var info = CodeMirror.modeInfo[i];
        if (info.mime == mime) return info;
        if (info.mimes) for (var j = 0; j < info.mimes.length; j++)
          if (info.mimes[j] == mime) return info;
      }
    };
  
    CodeMirror.findModeByExtension = function(ext) {
      for (var i = 0; i < CodeMirror.modeInfo.length; i++) {
        var info = CodeMirror.modeInfo[i];
        if (info.ext) for (var j = 0; j < info.ext.length; j++)
          if (info.ext[j] == ext) return info;
      }
    };
  
    CodeMirror.findModeByFileName = function(filename) {
      for (var i = 0; i < CodeMirror.modeInfo.length; i++) {
        var info = CodeMirror.modeInfo[i];
        if (info.file && info.file.test(filename)) return info;
      }
      var dot = filename.lastIndexOf(".");
      var ext = dot > -1 && filename.substring(dot + 1, filename.length);
      if (ext) return CodeMirror.findModeByExtension(ext);
    };
  
    CodeMirror.findModeByName = function(name) {
      name = name.toLowerCase();
      for (var i = 0; i < CodeMirror.modeInfo.length; i++) {
        var info = CodeMirror.modeInfo[i];
        if (info.name.toLowerCase() == name) return info;
        if (info.alias) for (var j = 0; j < info.alias.length; j++)
          if (info.alias[j].toLowerCase() == name) return info;
      }
    };
});

// 'codemirror/mode/gfm/gfm'
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";
    
    CodeMirror.defineMode("gfm", function(config, modeConfig) {
      var codeDepth = 0;
      function blankLine(state) {
        state.code = false;
        return null;
      }
      var gfmOverlay = {
        startState: function() {
          return {
            code: false,
            codeBlock: false,
            ateSpace: false
          };
        },
        copyState: function(s) {
          return {
            code: s.code,
            codeBlock: s.codeBlock,
            ateSpace: s.ateSpace
          };
        },
        token: function(stream, state) {
          state.combineTokens = null;
    
          // Hack to prevent formatting override inside code blocks (block and inline)
          if (state.codeBlock) {
            if (stream.match(/^```/)) {
              state.codeBlock = false;
              return null;
            }
            stream.skipToEnd();
            return null;
          }
          if (stream.sol()) {
            state.code = false;
          }
          if (stream.sol() && stream.match(/^```/)) {
            stream.skipToEnd();
            state.codeBlock = true;
            return null;
          }
          // If this block is changed, it may need to be updated in Markdown mode
          if (stream.peek() === '`') {
            stream.next();
            var before = stream.pos;
            stream.eatWhile('`');
            var difference = 1 + stream.pos - before;
            if (!state.code) {
              codeDepth = difference;
              state.code = true;
            } else {
              if (difference === codeDepth) { // Must be exact
                state.code = false;
              }
            }
            return null;
          } else if (state.code) {
            stream.next();
            return null;
          }
          // Check if space. If so, links can be formatted later on
          if (stream.eatSpace()) {
            state.ateSpace = true;
            return null;
          }
          if (stream.sol() || state.ateSpace) {
            state.ateSpace = false;
            if(stream.match(/^(?:[a-zA-Z0-9\-_]+\/)?(?:[a-zA-Z0-9\-_]+@)?(?:[a-f0-9]{7,40}\b)/)) {
              // User/Project@SHA
              // User@SHA
              // SHA
              state.combineTokens = true;
              return "link";
            } else if (stream.match(/^(?:[a-zA-Z0-9\-_]+\/)?(?:[a-zA-Z0-9\-_]+)?#[0-9]+\b/)) {
              // User/Project#Num
              // User#Num
              // #Num
              state.combineTokens = true;
              return "link";
            }
          }
          if (stream.match(/^((?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]|\([^\s()<>]*\))+(?:\([^\s()<>]*\)|[^\s`*!()\[\]{};:'".,<>?«»“”‘’]))/i) &&
             stream.string.slice(stream.start - 2, stream.start) != "](") {
            // URLs
            // Taken from http://daringfireball.net/2010/07/improved_regex_for_matching_urls
            // And then (issue #1160) simplified to make it not crash the Chrome Regexp engine
            state.combineTokens = true;
            return "link";
          }
          stream.next();
          return null;
        },
        blankLine: blankLine
      };
    
      var markdownConfig = {
        underscoresBreakWords: false,
        taskLists: true,
        fencedCodeBlocks: true,
        strikethrough: true
      };
      for (var attr in modeConfig) {
        markdownConfig[attr] = modeConfig[attr];
      }
      markdownConfig.name = "markdown";
      return CodeMirror.overlayMode(CodeMirror.getMode(config, markdownConfig), gfmOverlay);
    
    }, "markdown");
    
      CodeMirror.defineMIME("text/x-gfm", "gfm");
});

// codemirror/addon/mode/multiplex
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";
    
    CodeMirror.multiplexingMode = function(outer /*, others */) {
      // Others should be {open, close, mode [, delimStyle] [, innerStyle]} objects
      var others = Array.prototype.slice.call(arguments, 1);
    
      function indexOf(string, pattern, from, returnEnd) {
        if (typeof pattern == "string") {
          var found = string.indexOf(pattern, from);
          return returnEnd && found > -1 ? found + pattern.length : found;
        }
        var m = pattern.exec(from ? string.slice(from) : string);
        return m ? m.index + from + (returnEnd ? m[0].length : 0) : -1;
      }
    
      return {
        startState: function() {
          return {
            outer: CodeMirror.startState(outer),
            innerActive: null,
            inner: null
          };
        },
    
        copyState: function(state) {
          return {
            outer: CodeMirror.copyState(outer, state.outer),
            innerActive: state.innerActive,
            inner: state.innerActive && CodeMirror.copyState(state.innerActive.mode, state.inner)
          };
        },
    
        token: function(stream, state) {
          if (!state.innerActive) {
            var cutOff = Infinity, oldContent = stream.string;
            for (var i = 0; i < others.length; ++i) {
              var other = others[i];
              var found = indexOf(oldContent, other.open, stream.pos);
              if (found == stream.pos) {
                if (!other.parseDelimiters) stream.match(other.open);
                state.innerActive = other;
                state.inner = CodeMirror.startState(other.mode, outer.indent ? outer.indent(state.outer, "") : 0);
                return other.delimStyle;
              } else if (found != -1 && found < cutOff) {
                cutOff = found;
              }
            }
            if (cutOff != Infinity) stream.string = oldContent.slice(0, cutOff);
            var outerToken = outer.token(stream, state.outer);
            if (cutOff != Infinity) stream.string = oldContent;
            return outerToken;
          } else {
            var curInner = state.innerActive, oldContent = stream.string;
            if (!curInner.close && stream.sol()) {
              state.innerActive = state.inner = null;
              return this.token(stream, state);
            }
            var found = curInner.close ? indexOf(oldContent, curInner.close, stream.pos, curInner.parseDelimiters) : -1;
            if (found == stream.pos && !curInner.parseDelimiters) {
              stream.match(curInner.close);
              state.innerActive = state.inner = null;
              return curInner.delimStyle;
            }
            if (found > -1) stream.string = oldContent.slice(0, found);
            var innerToken = curInner.mode.token(stream, state.inner);
            if (found > -1) stream.string = oldContent;
    
            if (found == stream.pos && curInner.parseDelimiters)
              state.innerActive = state.inner = null;
    
            if (curInner.innerStyle) {
              if (innerToken) innerToken = innerToken + ' ' + curInner.innerStyle;
              else innerToken = curInner.innerStyle;
            }
    
            return innerToken;
          }
        },
    
        indent: function(state, textAfter) {
          var mode = state.innerActive ? state.innerActive.mode : outer;
          if (!mode.indent) return CodeMirror.Pass;
          return mode.indent(state.innerActive ? state.inner : state.outer, textAfter);
        },
    
        blankLine: function(state) {
          var mode = state.innerActive ? state.innerActive.mode : outer;
          if (mode.blankLine) {
            mode.blankLine(state.innerActive ? state.inner : state.outer);
          }
          if (!state.innerActive) {
            for (var i = 0; i < others.length; ++i) {
              var other = others[i];
              if (other.open === "\n") {
                state.innerActive = other;
                state.inner = CodeMirror.startState(other.mode, mode.indent ? mode.indent(state.outer, "") : 0);
              }
            }
          } else if (state.innerActive.close === "\n") {
            state.innerActive = state.inner = null;
          }
        },
    
        electricChars: outer.electricChars,
    
        innerMode: function(state) {
          return state.inner ? {state: state.inner, mode: state.innerActive.mode} : {state: state.outer, mode: outer};
        }
      };
    };
    
});

// codemirror/mode/python/python
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";
  
    function wordRegexp(words) {
      return new RegExp("^((" + words.join(")|(") + "))\\b");
    }
  
    var wordOperators = wordRegexp(["and", "or", "not", "is"]);
    var commonKeywords = ["as", "assert", "break", "class", "continue",
                          "def", "del", "elif", "else", "except", "finally",
                          "for", "from", "global", "if", "import",
                          "lambda", "pass", "raise", "return",
                          "try", "while", "with", "yield", "in"];
    var commonBuiltins = ["abs", "all", "any", "bin", "bool", "bytearray", "callable", "chr",
                          "classmethod", "compile", "complex", "delattr", "dict", "dir", "divmod",
                          "enumerate", "eval", "filter", "float", "format", "frozenset",
                          "getattr", "globals", "hasattr", "hash", "help", "hex", "id",
                          "input", "int", "isinstance", "issubclass", "iter", "len",
                          "list", "locals", "map", "max", "memoryview", "min", "next",
                          "object", "oct", "open", "ord", "pow", "property", "range",
                          "repr", "reversed", "round", "set", "setattr", "slice",
                          "sorted", "staticmethod", "str", "sum", "super", "tuple",
                          "type", "vars", "zip", "__import__", "NotImplemented",
                          "Ellipsis", "__debug__"];
    var py2 = {builtins: ["apply", "basestring", "buffer", "cmp", "coerce", "execfile",
                          "file", "intern", "long", "raw_input", "reduce", "reload",
                          "unichr", "unicode", "xrange", "False", "True", "None"],
               keywords: ["exec", "print"]};
    var py3 = {builtins: ["ascii", "bytes", "exec", "print"],
               keywords: ["nonlocal", "False", "True", "None", "async", "await"]};
  
    CodeMirror.registerHelper("hintWords", "python", commonKeywords.concat(commonBuiltins));
  
    function top(state) {
      return state.scopes[state.scopes.length - 1];
    }
  
    CodeMirror.defineMode("python", function(conf, parserConf) {
      var ERRORCLASS = "error";
  
      var singleDelimiters = parserConf.singleDelimiters || new RegExp("^[\\(\\)\\[\\]\\{\\}@,:`=;\\.]");
      var doubleOperators = parserConf.doubleOperators || new RegExp("^((==)|(!=)|(<=)|(>=)|(<>)|(<<)|(>>)|(//)|(\\*\\*))");
      var doubleDelimiters = parserConf.doubleDelimiters || new RegExp("^((\\+=)|(\\-=)|(\\*=)|(%=)|(/=)|(&=)|(\\|=)|(\\^=))");
      var tripleDelimiters = parserConf.tripleDelimiters || new RegExp("^((//=)|(>>=)|(<<=)|(\\*\\*=))");
  
      if (parserConf.version && parseInt(parserConf.version, 10) == 3){
          // since http://legacy.python.org/dev/peps/pep-0465/ @ is also an operator
          var singleOperators = parserConf.singleOperators || new RegExp("^[\\+\\-\\*/%&|\\^~<>!@]");
          var identifiers = parserConf.identifiers|| new RegExp("^[_A-Za-z\u00A1-\uFFFF][_A-Za-z0-9\u00A1-\uFFFF]*");
      } else {
          var singleOperators = parserConf.singleOperators || new RegExp("^[\\+\\-\\*/%&|\\^~<>!]");
          var identifiers = parserConf.identifiers|| new RegExp("^[_A-Za-z][_A-Za-z0-9]*");
      }
  
      var hangingIndent = parserConf.hangingIndent || conf.indentUnit;
  
      var myKeywords = commonKeywords, myBuiltins = commonBuiltins;
      if(parserConf.extra_keywords != undefined){
        myKeywords = myKeywords.concat(parserConf.extra_keywords);
      }
      if(parserConf.extra_builtins != undefined){
        myBuiltins = myBuiltins.concat(parserConf.extra_builtins);
      }
      if (parserConf.version && parseInt(parserConf.version, 10) == 3) {
        myKeywords = myKeywords.concat(py3.keywords);
        myBuiltins = myBuiltins.concat(py3.builtins);
        var stringPrefixes = new RegExp("^(([rb]|(br))?('{3}|\"{3}|['\"]))", "i");
      } else {
        myKeywords = myKeywords.concat(py2.keywords);
        myBuiltins = myBuiltins.concat(py2.builtins);
        var stringPrefixes = new RegExp("^(([rub]|(ur)|(br))?('{3}|\"{3}|['\"]))", "i");
      }
      var keywords = wordRegexp(myKeywords);
      var builtins = wordRegexp(myBuiltins);
  
      // tokenizers
      function tokenBase(stream, state) {
        // Handle scope changes
        if (stream.sol() && top(state).type == "py") {
          var scopeOffset = top(state).offset;
          if (stream.eatSpace()) {
            var lineOffset = stream.indentation();
            if (lineOffset > scopeOffset)
              pushScope(stream, state, "py");
            else if (lineOffset < scopeOffset && dedent(stream, state))
              state.errorToken = true;
            return null;
          } else {
            var style = tokenBaseInner(stream, state);
            if (scopeOffset > 0 && dedent(stream, state))
              style += " " + ERRORCLASS;
            return style;
          }
        }
        return tokenBaseInner(stream, state);
      }
  
      function tokenBaseInner(stream, state) {
        if (stream.eatSpace()) return null;
  
        var ch = stream.peek();
  
        // Handle Comments
        if (ch == "#") {
          stream.skipToEnd();
          return "comment";
        }
  
        // Handle Number Literals
        if (stream.match(/^[0-9\.]/, false)) {
          var floatLiteral = false;
          // Floats
          if (stream.match(/^\d*\.\d+(e[\+\-]?\d+)?/i)) { floatLiteral = true; }
          if (stream.match(/^\d+\.\d*/)) { floatLiteral = true; }
          if (stream.match(/^\.\d+/)) { floatLiteral = true; }
          if (floatLiteral) {
            // Float literals may be "imaginary"
            stream.eat(/J/i);
            return "number";
          }
          // Integers
          var intLiteral = false;
          // Hex
          if (stream.match(/^0x[0-9a-f]+/i)) intLiteral = true;
          // Binary
          if (stream.match(/^0b[01]+/i)) intLiteral = true;
          // Octal
          if (stream.match(/^0o[0-7]+/i)) intLiteral = true;
          // Decimal
          if (stream.match(/^[1-9]\d*(e[\+\-]?\d+)?/)) {
            // Decimal literals may be "imaginary"
            stream.eat(/J/i);
            // TODO - Can you have imaginary longs?
            intLiteral = true;
          }
          // Zero by itself with no other piece of number.
          if (stream.match(/^0(?![\dx])/i)) intLiteral = true;
          if (intLiteral) {
            // Integer literals may be "long"
            stream.eat(/L/i);
            return "number";
          }
        }
  
        // Handle Strings
        if (stream.match(stringPrefixes)) {
          state.tokenize = tokenStringFactory(stream.current());
          return state.tokenize(stream, state);
        }
  
        // Handle operators and Delimiters
        if (stream.match(tripleDelimiters) || stream.match(doubleDelimiters))
          return null;
  
        if (stream.match(doubleOperators) || stream.match(singleOperators))
          return "operator";
  
        if (stream.match(singleDelimiters))
          return null;
  
        if (stream.match(keywords) || stream.match(wordOperators))
          return "keyword";
  
        if (stream.match(builtins))
          return "builtin";
  
        if (stream.match(/^(self|cls)\b/))
          return "variable-2";
  
        if (stream.match(identifiers)) {
          if (state.lastToken == "def" || state.lastToken == "class")
            return "def";
          return "variable";
        }
  
        // Handle non-detected items
        stream.next();
        return ERRORCLASS;
      }
  
      function tokenStringFactory(delimiter) {
        while ("rub".indexOf(delimiter.charAt(0).toLowerCase()) >= 0)
          delimiter = delimiter.substr(1);
  
        var singleline = delimiter.length == 1;
        var OUTCLASS = "string";
  
        function tokenString(stream, state) {
          while (!stream.eol()) {
            stream.eatWhile(/[^'"\\]/);
            if (stream.eat("\\")) {
              stream.next();
              if (singleline && stream.eol())
                return OUTCLASS;
            } else if (stream.match(delimiter)) {
              state.tokenize = tokenBase;
              return OUTCLASS;
            } else {
              stream.eat(/['"]/);
            }
          }
          if (singleline) {
            if (parserConf.singleLineStringErrors)
              return ERRORCLASS;
            else
              state.tokenize = tokenBase;
          }
          return OUTCLASS;
        }
        tokenString.isString = true;
        return tokenString;
      }
  
      function pushScope(stream, state, type) {
        var offset = 0, align = null;
        if (type == "py") {
          while (top(state).type != "py")
            state.scopes.pop();
        }
        offset = top(state).offset + (type == "py" ? conf.indentUnit : hangingIndent);
        if (type != "py" && !stream.match(/^(\s|#.*)*$/, false))
          align = stream.column() + 1;
        state.scopes.push({offset: offset, type: type, align: align});
      }
  
      function dedent(stream, state) {
        var indented = stream.indentation();
        while (top(state).offset > indented) {
          if (top(state).type != "py") return true;
          state.scopes.pop();
        }
        return top(state).offset != indented;
      }
  
      function tokenLexer(stream, state) {
        var style = state.tokenize(stream, state);
        var current = stream.current();
  
        // Handle '.' connected identifiers
        if (current == ".") {
          style = stream.match(identifiers, false) ? null : ERRORCLASS;
          if (style == null && state.lastStyle == "meta") {
            // Apply 'meta' style to '.' connected identifiers when
            // appropriate.
            style = "meta";
          }
          return style;
        }
  
        // Handle decorators
        if (current == "@"){
          if(parserConf.version && parseInt(parserConf.version, 10) == 3){
              return stream.match(identifiers, false) ? "meta" : "operator";
          } else {
              return stream.match(identifiers, false) ? "meta" : ERRORCLASS;
          }
        }
  
        if ((style == "variable" || style == "builtin")
            && state.lastStyle == "meta")
          style = "meta";
  
        // Handle scope changes.
        if (current == "pass" || current == "return")
          state.dedent += 1;
  
        if (current == "lambda") state.lambda = true;
        if (current == ":" && !state.lambda && top(state).type == "py")
          pushScope(stream, state, "py");
  
        var delimiter_index = current.length == 1 ? "[({".indexOf(current) : -1;
        if (delimiter_index != -1)
          pushScope(stream, state, "])}".slice(delimiter_index, delimiter_index+1));
  
        delimiter_index = "])}".indexOf(current);
        if (delimiter_index != -1) {
          if (top(state).type == current) state.scopes.pop();
          else return ERRORCLASS;
        }
        if (state.dedent > 0 && stream.eol() && top(state).type == "py") {
          if (state.scopes.length > 1) state.scopes.pop();
          state.dedent -= 1;
        }
  
        return style;
      }
  
      var external = {
        startState: function(basecolumn) {
          return {
            tokenize: tokenBase,
            scopes: [{offset: basecolumn || 0, type: "py", align: null}],
            lastStyle: null,
            lastToken: null,
            lambda: false,
            dedent: 0
          };
        },
  
        token: function(stream, state) {
          var addErr = state.errorToken;
          if (addErr) state.errorToken = false;
          var style = tokenLexer(stream, state);
  
          state.lastStyle = style;
  
          var current = stream.current();
          if (current && style)
            state.lastToken = current;
  
          if (stream.eol() && state.lambda)
            state.lambda = false;
          return addErr ? style + " " + ERRORCLASS : style;
        },
  
        indent: function(state, textAfter) {
          if (state.tokenize != tokenBase)
            return state.tokenize.isString ? CodeMirror.Pass : 0;
  
          var scope = top(state);
          var closing = textAfter && textAfter.charAt(0) == scope.type;
          if (scope.align != null)
            return scope.align - (closing ? 1 : 0);
          else if (closing && state.scopes.length > 1)
            return state.scopes[state.scopes.length - 2].offset;
          else
            return scope.offset;
        },
  
        closeBrackets: {triples: "'\""},
        lineComment: "#",
        fold: "indent"
      };
      return external;
  });
  CodeMirror.defineMIME("text/x-python", "python");
  
    var words = function(str) { return str.split(" "); };
  
    CodeMirror.defineMIME("text/x-cython", {
      name: "python",
      extra_keywords: words("by cdef cimport cpdef ctypedef enum except"+
                            "extern gil include nogil property public"+
                            "readonly struct union DEF IF ELIF ELSE")
    });
  
});

// codemirror/mode/stex/stex
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";
  
    CodeMirror.defineMode("stex", function() {
      "use strict";
  
      function pushCommand(state, command) {
        state.cmdState.push(command);
      }
  
      function peekCommand(state) {
        if (state.cmdState.length > 0) {
          return state.cmdState[state.cmdState.length - 1];
        } else {
          return null;
        }
      }
  
      function popCommand(state) {
        var plug = state.cmdState.pop();
        if (plug) {
          plug.closeBracket();
        }
      }
  
      // returns the non-default plugin closest to the end of the list
      function getMostPowerful(state) {
        var context = state.cmdState;
        for (var i = context.length - 1; i >= 0; i--) {
          var plug = context[i];
          if (plug.name == "DEFAULT") {
            continue;
          }
          return plug;
        }
        return { styleIdentifier: function() { return null; } };
      }
  
      function addPluginPattern(pluginName, cmdStyle, styles) {
        return function () {
          this.name = pluginName;
          this.bracketNo = 0;
          this.style = cmdStyle;
          this.styles = styles;
          this.argument = null;   // \begin and \end have arguments that follow. These are stored in the plugin
  
          this.styleIdentifier = function() {
            return this.styles[this.bracketNo - 1] || null;
          };
          this.openBracket = function() {
            this.bracketNo++;
            return "bracket";
          };
          this.closeBracket = function() {};
        };
      }
  
      var plugins = {};
  
      plugins["importmodule"] = addPluginPattern("importmodule", "tag", ["string", "builtin"]);
      plugins["documentclass"] = addPluginPattern("documentclass", "tag", ["", "atom"]);
      plugins["usepackage"] = addPluginPattern("usepackage", "tag", ["atom"]);
      plugins["begin"] = addPluginPattern("begin", "tag", ["atom"]);
      plugins["end"] = addPluginPattern("end", "tag", ["atom"]);
  
      plugins["DEFAULT"] = function () {
        this.name = "DEFAULT";
        this.style = "tag";
  
        this.styleIdentifier = this.openBracket = this.closeBracket = function() {};
      };
  
      function setState(state, f) {
        state.f = f;
      }
  
      // called when in a normal (no environment) context
      function normal(source, state) {
        var plug;
        // Do we look like '\command' ?  If so, attempt to apply the plugin 'command'
        if (source.match(/^\\[a-zA-Z@]+/)) {
          var cmdName = source.current().slice(1);
          plug = plugins[cmdName] || plugins["DEFAULT"];
          plug = new plug();
          pushCommand(state, plug);
          setState(state, beginParams);
          return plug.style;
        }
  
        // escape characters
        if (source.match(/^\\[$&%#{}_]/)) {
          return "tag";
        }
  
        // white space control characters
        if (source.match(/^\\[,;!\/\\]/)) {
          return "tag";
        }
  
        // find if we're starting various math modes
        if (source.match("\\[")) {
          setState(state, function(source, state){ return inMathMode(source, state, "\\]"); });
          return "keyword";
        }
        if (source.match("$$")) {
          setState(state, function(source, state){ return inMathMode(source, state, "$$"); });
          return "keyword";
        }
        if (source.match("$")) {
          setState(state, function(source, state){ return inMathMode(source, state, "$"); });
          return "keyword";
        }
  
        var ch = source.next();
        if (ch == "%") {
          source.skipToEnd();
          return "comment";
        } else if (ch == '}' || ch == ']') {
          plug = peekCommand(state);
          if (plug) {
            plug.closeBracket(ch);
            setState(state, beginParams);
          } else {
            return "error";
          }
          return "bracket";
        } else if (ch == '{' || ch == '[') {
          plug = plugins["DEFAULT"];
          plug = new plug();
          pushCommand(state, plug);
          return "bracket";
        } else if (/\d/.test(ch)) {
          source.eatWhile(/[\w.%]/);
          return "atom";
        } else {
          source.eatWhile(/[\w\-_]/);
          plug = getMostPowerful(state);
          if (plug.name == 'begin') {
            plug.argument = source.current();
          }
          return plug.styleIdentifier();
        }
      }
  
      function inMathMode(source, state, endModeSeq) {
        if (source.eatSpace()) {
          return null;
        }
        if (source.match(endModeSeq)) {
          setState(state, normal);
          return "keyword";
        }
        if (source.match(/^\\[a-zA-Z@]+/)) {
          return "tag";
        }
        if (source.match(/^[a-zA-Z]+/)) {
          return "variable-2";
        }
        // escape characters
        if (source.match(/^\\[$&%#{}_]/)) {
          return "tag";
        }
        // white space control characters
        if (source.match(/^\\[,;!\/]/)) {
          return "tag";
        }
        // special math-mode characters
        if (source.match(/^[\^_&]/)) {
          return "tag";
        }
        // non-special characters
        if (source.match(/^[+\-<>|=,\/@!*:;'"`~#?]/)) {
          return null;
        }
        if (source.match(/^(\d+\.\d*|\d*\.\d+|\d+)/)) {
          return "number";
        }
        var ch = source.next();
        if (ch == "{" || ch == "}" || ch == "[" || ch == "]" || ch == "(" || ch == ")") {
          return "bracket";
        }
  
        if (ch == "%") {
          source.skipToEnd();
          return "comment";
        }
        return "error";
      }
  
      function beginParams(source, state) {
        var ch = source.peek(), lastPlug;
        if (ch == '{' || ch == '[') {
          lastPlug = peekCommand(state);
          lastPlug.openBracket(ch);
          source.eat(ch);
          setState(state, normal);
          return "bracket";
        }
        if (/[ \t\r]/.test(ch)) {
          source.eat(ch);
          return null;
        }
        setState(state, normal);
        popCommand(state);
  
        return normal(source, state);
      }
  
      return {
        startState: function() {
          return {
            cmdState: [],
            f: normal
          };
        },
        copyState: function(s) {
          return {
            cmdState: s.cmdState.slice(),
            f: s.f
          };
        },
        token: function(stream, state) {
          return state.f(stream, state);
        },
        blankLine: function(state) {
          state.f = normal;
          state.cmdState.length = 0;
        },
        lineComment: "%"
      };
    });
  
    CodeMirror.defineMIME("text/x-stex", "stex");
    CodeMirror.defineMIME("text/x-latex", "stex");
  
});

// notebook/js/codemirror-ipythongfm
(function(mod) {
    mod(CodeMirror);
})(function(CodeMirror) {
    "use strict";

    CodeMirror.defineMode("ipythongfm", function(config, parserConfig) {

        var gfm_mode = CodeMirror.getMode(config, "gfm");
        var tex_mode = CodeMirror.getMode(config, "stex");

        return CodeMirror.multiplexingMode(
            gfm_mode,
            {
                open: "$", close: "$",
                mode: tex_mode,
                delimStyle: "delimit"
            },
            {
                // not sure this works as $$ is interpreted at (opening $, closing $, as defined just above)
                open: "$$", close: "$$",
                mode: tex_mode,
                delimStyle: "delimit"
            },
            {
                open: "\\(", close: "\\)",
                mode: tex_mode,
                delimStyle: "delimit"
            },
            {
                open: "\\[", close: "\\]",
                mode: tex_mode,
                delimStyle: "delimit"
            }
            // .. more multiplexed styles can follow here
        );
    }, 'gfm');

    CodeMirror.defineMIME("text/x-ipythongfm", "ipythongfm");
});


var baseJsUtils = (function baseJsUtils() {
    "use strict";

    /**
     * Load a single extension.
     * @param  {string} extension - extension path.
     * @return {Promise} that resolves to an extension module handle
     */
    var load_extension = function (extension) {
        return new Promise(function(resolve, reject) {
            require(["nbextensions/" + extension], function(module) {
                console.log("Loaded extension: " + extension);
                try {
                    module.load_ipython_extension();
                } finally {
                    resolve(module);
                }
            }, function(err) {
                reject(err);
            });
        });
    };

    /**
     * Load multiple extensions.
     * Takes n-args, where each arg is a string path to the extension.
     * @return {Promise} that resolves to a list of loaded module handles.
     */
    var load_extensions = function () {
        return Promise.all(Array.prototype.map.call(arguments, load_extension)).catch(function(err) {
            console.error("Failed to load extension" + (err.requireModules.length>1?'s':'') + ":", err.requireModules, err);
        });
    };

    /**
     * Wait for a config section to load, and then load the extensions specified
     * in a 'load_extensions' key inside it.
     */
    function load_extensions_from_config(section) {
        section.loaded.then(function() {
            if (section.data.load_extensions) {
                var nbextension_paths = Object.getOwnPropertyNames(
                                            section.data.load_extensions);
                load_extensions.apply(this, nbextension_paths);
            }
        });
    }

    //============================================================================
    // Cross-browser RegEx Split
    //============================================================================

    // This code has been MODIFIED from the code licensed below to not replace the
    // default browser split.  The license is reproduced here.

    // see http://blog.stevenlevithan.com/archives/cross-browser-split for more info:
    /*!
     * Cross-Browser Split 1.1.1
     * Copyright 2007-2012 Steven Levithan <stevenlevithan.com>
     * Available under the MIT License
     * ECMAScript compliant, uniform cross-browser split method
     */

    /**
     * Splits a string into an array of strings using a regex or string
     * separator. Matches of the separator are not included in the result array.
     * However, if `separator` is a regex that contains capturing groups,
     * backreferences are spliced into the result each time `separator` is
     * matched. Fixes browser bugs compared to the native
     * `String.prototype.split` and can be used reliably cross-browser.
     * @param {String} str String to split.
     * @param {RegExp} separator Regex to use for separating
     *     the string.
     * @param {Number} [limit] Maximum number of items to include in the result
     *     array.
     * @returns {Array} Array of substrings.
     * @example
     *
     * // Basic use
     * regex_split('a b c d', ' ');
     * // -> ['a', 'b', 'c', 'd']
     *
     * // With limit
     * regex_split('a b c d', ' ', 2);
     * // -> ['a', 'b']
     *
     * // Backreferences in result array
     * regex_split('..word1 word2..', /([a-z]+)(\d+)/i);
     * // -> ['..', 'word', '1', ' ', 'word', '2', '..']
     */
    var regex_split = function (str, separator, limit) {
        var output = [],
            flags = (separator.ignoreCase ? "i" : "") +
                    (separator.multiline  ? "m" : "") +
                    (separator.extended   ? "x" : "") + // Proposed for ES6
                    (separator.sticky     ? "y" : ""), // Firefox 3+
            lastLastIndex = 0,
            separator2, match, lastIndex, lastLength;
        // Make `global` and avoid `lastIndex` issues by working with a copy
        separator = new RegExp(separator.source, flags + "g");

        var compliantExecNpcg = typeof(/()??/.exec("")[1]) === "undefined";
        if (!compliantExecNpcg) {
            // Doesn't need flags gy, but they don't hurt
            separator2 = new RegExp("^" + separator.source + "$(?!\\s)", flags);
        }
        /* Values for `limit`, per the spec:
         * If undefined: 4294967295 // Math.pow(2, 32) - 1
         * If 0, Infinity, or NaN: 0
         * If positive number: limit = Math.floor(limit); if (limit > 4294967295) limit -= 4294967296;
         * If negative number: 4294967296 - Math.floor(Math.abs(limit))
         * If other: Type-convert, then use the above rules
         */
        limit = typeof(limit) === "undefined" ?
            -1 >>> 0 : // Math.pow(2, 32) - 1
            limit >>> 0; // ToUint32(limit)
        for (match = separator.exec(str); match; match = separator.exec(str)) {
            // `separator.lastIndex` is not reliable cross-browser
            lastIndex = match.index + match[0].length;
            if (lastIndex > lastLastIndex) {
                output.push(str.slice(lastLastIndex, match.index));
                // Fix browsers whose `exec` methods don't consistently return `undefined` for
                // nonparticipating capturing groups
                if (!compliantExecNpcg && match.length > 1) {
                    match[0].replace(separator2, function () {
                        for (var i = 1; i < arguments.length - 2; i++) {
                            if (typeof(arguments[i]) === "undefined") {
                                match[i] = undefined;
                            }
                        }
                    });
                }
                if (match.length > 1 && match.index < str.length) {
                    Array.prototype.push.apply(output, match.slice(1));
                }
                lastLength = match[0].length;
                lastLastIndex = lastIndex;
                if (output.length >= limit) {
                    break;
                }
            }
            if (separator.lastIndex === match.index) {
                separator.lastIndex++; // Avoid an infinite loop
            }
        }
        if (lastLastIndex === str.length) {
            if (lastLength || !separator.test("")) {
                output.push("");
            }
        } else {
            output.push(str.slice(lastLastIndex));
        }
        return output.length > limit ? output.slice(0, limit) : output;
    };

    //============================================================================
    // End contributed Cross-browser RegEx Split
    //============================================================================


    var uuid = function () {
        /**
         * http://www.ietf.org/rfc/rfc4122.txt
         */
        var s = [];
        var hexDigits = "0123456789ABCDEF";
        for (var i = 0; i < 32; i++) {
            s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
        }
        s[12] = "4";  // bits 12-15 of the time_hi_and_version field to 0010
        s[16] = hexDigits.substr((s[16] & 0x3) | 0x8, 1);  // bits 6-7 of the clock_seq_hi_and_reserved to 01

        var uuid = s.join("");
        return uuid;
    };


    //Fix raw text to parse correctly in crazy XML
    function xmlencode(string) {
        return string.replace(/\&/g,'&'+'amp;')
            .replace(/</g,'&'+'lt;')
            .replace(/>/g,'&'+'gt;')
            .replace(/\'/g,'&'+'apos;')
            .replace(/\"/g,'&'+'quot;')
            .replace(/`/g,'&'+'#96;');
    }


    //Map from terminal commands to CSS classes
    var ansi_colormap = {
        "01":"ansibold",

        "30":"ansiblack",
        "31":"ansired",
        "32":"ansigreen",
        "33":"ansiyellow",
        "34":"ansiblue",
        "35":"ansipurple",
        "36":"ansicyan",
        "37":"ansigray",

        "40":"ansibgblack",
        "41":"ansibgred",
        "42":"ansibggreen",
        "43":"ansibgyellow",
        "44":"ansibgblue",
        "45":"ansibgpurple",
        "46":"ansibgcyan",
        "47":"ansibggray"
    };

    function _process_numbers(attrs, numbers) {
        // process ansi escapes
        var n = numbers.shift();
        if (ansi_colormap[n]) {
            if ( ! attrs["class"] ) {
                attrs["class"] = ansi_colormap[n];
            } else {
                attrs["class"] += " " + ansi_colormap[n];
            }
        } else if (n == "38" || n == "48") {
            // VT100 256 color or 24 bit RGB
            if (numbers.length < 2) {
                console.log("Not enough fields for VT100 color", numbers);
                return;
            }

            var index_or_rgb = numbers.shift();
            var r,g,b;
            if (index_or_rgb == "5") {
                // 256 color
                var idx = parseInt(numbers.shift(), 10);
                if (idx < 16) {
                    // indexed ANSI
                    // ignore bright / non-bright distinction
                    idx = idx % 8;
                    var ansiclass = ansi_colormap[n[0] + (idx % 8).toString()];
                    if ( ! attrs["class"] ) {
                        attrs["class"] = ansiclass;
                    } else {
                        attrs["class"] += " " + ansiclass;
                    }
                    return;
                } else if (idx < 232) {
                    // 216 color 6x6x6 RGB
                    idx = idx - 16;
                    b = idx % 6;
                    g = Math.floor(idx / 6) % 6;
                    r = Math.floor(idx / 36) % 6;
                    // convert to rgb
                    r = (r * 51);
                    g = (g * 51);
                    b = (b * 51);
                } else {
                    // grayscale
                    idx = idx - 231;
                    // it's 1-24 and should *not* include black or white,
                    // so a 26 point scale
                    r = g = b = Math.floor(idx * 256 / 26);
                }
            } else if (index_or_rgb == "2") {
                // Simple 24 bit RGB
                if (numbers.length > 3) {
                    console.log("Not enough fields for RGB", numbers);
                    return;
                }
                r = numbers.shift();
                g = numbers.shift();
                b = numbers.shift();
            } else {
                console.log("unrecognized control", numbers);
                return;
            }
            if (r !== undefined) {
                // apply the rgb color
                var line;
                if (n == "38") {
                    line = "color: ";
                } else {
                    line = "background-color: ";
                }
                line = line + "rgb(" + r + "," + g + "," + b + ");";
                if ( !attrs.style ) {
                    attrs.style = line;
                } else {
                    attrs.style += " " + line;
                }
            }
        }
    }

    function ansispan(str) {
        // ansispan function adapted from github.com/mmalecki/ansispan (MIT License)
        // regular ansi escapes (using the table above)
        var is_open = false;
        return str.replace(/\033\[(0?[01]|22|39)?([;\d]+)?m/g, function(match, prefix, pattern) {
            if (!pattern) {
                // [(01|22|39|)m close spans
                if (is_open) {
                    is_open = false;
                    return "</span>";
                } else {
                    return "";
                }
            } else {
                is_open = true;

                // consume sequence of color escapes
                var numbers = pattern.match(/\d+/g);
                var attrs = {};
                while (numbers.length > 0) {
                    _process_numbers(attrs, numbers);
                }

                var span = "<span ";
                Object.keys(attrs).map(function (attr) {
                    span = span + " " + attr + '="' + attrs[attr] + '"';
                });
                return span + ">";
            }
        });
    }

    // Transform ANSI color escape codes into HTML <span> tags with css
    // classes listed in the above ansi_colormap object. The actual color used
    // are set in the css file.
    function fixConsole(txt) {
        txt = xmlencode(txt);

        // Strip all ANSI codes that are not color related.  Matches
        // all ANSI codes that do not end with "m".
        var ignored_re = /(?=(\033\[[\d;=]*[a-ln-zA-Z]{1}))\1(?!m)/g;
        txt = txt.replace(ignored_re, "");

        // color ansi codes
        txt = ansispan(txt);
        return txt;
    }

    // Remove chunks that should be overridden by the effect of
    // carriage return characters
    function fixCarriageReturn(txt) {
        var tmp = txt;
        do {
            txt = tmp;
            tmp = txt.replace(/\r+\n/gm, '\n'); // \r followed by \n --> newline
            tmp = tmp.replace(/^.*\r+/gm, '');  // Other \r --> clear line
        } while (tmp.length < txt.length);
        return txt;
    }

    // Locate any URLs and convert them to a anchor tag
    function autoLinkUrls(txt) {
        return txt.replace(/(^|\s)(https?|ftp)(:[^'">\s]+)/gi,
            "$1<a target=\"_blank\" href=\"$2$3\">$2$3</a>");
    }

    var points_to_pixels = function (points) {
        /**
         * A reasonably good way of converting between points and pixels.
         */
        var test = $('<div style="display: none; width: 10000pt; padding:0; border:0;"></div>');
        $('body').append(test);
        var pixel_per_point = test.width()/10000;
        test.remove();
        return Math.floor(points*pixel_per_point);
    };

    var always_new = function (constructor) {
        /**
         * wrapper around contructor to avoid requiring `var a = new constructor()`
         * useful for passing constructors as callbacks,
         * not for programmer laziness.
         * from http://programmers.stackexchange.com/questions/118798
         */
        return function () {
            var obj = Object.create(constructor.prototype);
            constructor.apply(obj, arguments);
            return obj;
        };
    };

    var url_path_join = function () {
        /**
         * join a sequence of url components with '/'
         */
        var url = '';
        for (var i = 0; i < arguments.length; i++) {
            if (arguments[i] === '') {
                continue;
            }
            if (url.length > 0 && url[url.length-1] != '/') {
                url = url + '/' + arguments[i];
            } else {
                url = url + arguments[i];
            }
        }
        url = url.replace(/\/\/+/, '/');
        return url;
    };

    var url_path_split = function (path) {
        /**
         * Like os.path.split for URLs.
         * Always returns two strings, the directory path and the base filename
         */

        var idx = path.lastIndexOf('/');
        if (idx === -1) {
            return ['', path];
        } else {
            return [ path.slice(0, idx), path.slice(idx + 1) ];
        }
    };

    var parse_url = function (url) {
        /**
         * an `a` element with an href allows attr-access to the parsed segments of a URL
         * a = parse_url("http://localhost:8888/path/name#hash")
         * a.protocol = "http:"
         * a.host     = "localhost:8888"
         * a.hostname = "localhost"
         * a.port     = 8888
         * a.pathname = "/path/name"
         * a.hash     = "#hash"
         */
        var a = document.createElement("a");
        a.href = url;
        return a;
    };

    var encode_uri_components = function (uri) {
        /**
         * encode just the components of a multi-segment uri,
         * leaving '/' separators
         */
        return uri.split('/').map(encodeURIComponent).join('/');
    };

    var url_join_encode = function () {
        /**
         * join a sequence of url components with '/',
         * encoding each component with encodeURIComponent
         */
        return encode_uri_components(url_path_join.apply(null, arguments));
    };


    var splitext = function (filename) {
        /**
         * mimic Python os.path.splitext
         * Returns ['base', '.ext']
         */
        var idx = filename.lastIndexOf('.');
        if (idx > 0) {
            return [filename.slice(0, idx), filename.slice(idx)];
        } else {
            return [filename, ''];
        }
    };


    var escape_html = function (text) {
        /**
         * escape text to HTML
         */
        return $("<div/>").text(text).html();
    };


    var get_body_data = function(key) {
        /**
         * get a url-encoded item from body.data and decode it
         * we should never have any encoded URLs anywhere else in code
         * until we are building an actual request
         */
        var val = $('body').data(key);
        if (!val)
            return val;
        return decodeURIComponent(val);
    };

    var to_absolute_cursor_pos = function (cm, cursor) {
        /**
         * get the absolute cursor position from CodeMirror's col, ch
         */
        if (!cursor) {
            cursor = cm.getCursor();
        }
        var cursor_pos = cursor.ch;
        for (var i = 0; i < cursor.line; i++) {
            cursor_pos += cm.getLine(i).length + 1;
        }
        return cursor_pos;
    };

    var from_absolute_cursor_pos = function (cm, cursor_pos) {
        /**
         * turn absolute cursor position into CodeMirror col, ch cursor
         */
        var i, line, next_line;
        var offset = 0;
        for (i = 0, next_line=cm.getLine(i); next_line !== undefined; i++, next_line=cm.getLine(i)) {
            line = next_line;
            if (offset + next_line.length < cursor_pos) {
                offset += next_line.length + 1;
            } else {
                return {
                    line : i,
                    ch : cursor_pos - offset,
                };
            }
        }
        // reached end, return endpoint
        return {
            line : i - 1,
            ch : line.length - 1,
        };
    };

    // http://stackoverflow.com/questions/2400935/browser-detection-in-javascript
    var browser = (function() {
        if (typeof navigator === 'undefined') {
            // navigator undefined in node
            return 'None';
        }
        var N= navigator.appName, ua= navigator.userAgent, tem;
        var M= ua.match(/(opera|chrome|safari|firefox|msie)\/?\s*(\.?\d+(\.\d+)*)/i);
        if (M && (tem= ua.match(/version\/([\.\d]+)/i)) !== null) M[2]= tem[1];
        M= M? [M[1], M[2]]: [N, navigator.appVersion,'-?'];
        return M;
    })();

    // http://stackoverflow.com/questions/11219582/how-to-detect-my-browser-version-and-operating-system-using-javascript
    var platform = (function () {
        if (typeof navigator === 'undefined') {
            // navigator undefined in node
            return 'None';
        }
        var OSName="None";
        if (navigator.appVersion.indexOf("Win")!=-1) OSName="Windows";
        if (navigator.appVersion.indexOf("Mac")!=-1) OSName="MacOS";
        if (navigator.appVersion.indexOf("X11")!=-1) OSName="UNIX";
        if (navigator.appVersion.indexOf("Linux")!=-1) OSName="Linux";
        return OSName;
    })();

    var get_url_param = function (name) {
        // get a URL parameter. I cannot believe we actually need this.
        // Based on http://stackoverflow.com/a/25359264/938949
        var match = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
        if (match){
            return decodeURIComponent(match[1] || '');
        }
    };

    var is_or_has = function (a, b) {
        /**
         * Is b a child of a or a itself?
         */
        return a.has(b).length !==0 || a.is(b);
    };

    var is_focused = function (e) {
        /**
         * Is element e, or one of its children focused?
         */
        e = $(e);
        var target = $(document.activeElement);
        if (target.length > 0) {
            if (is_or_has(e, target)) {
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }
    };

    var mergeopt = function(_class, options, overwrite){
        options = options || {};
        overwrite = overwrite || {};
        return $.extend(true, {}, _class.options_default, options, overwrite);
    };

    var ajax_error_msg = function (jqXHR) {
        /**
         * Return a JSON error message if there is one,
         * otherwise the basic HTTP status text.
         */
        if (jqXHR.responseJSON && jqXHR.responseJSON.traceback) {
            return jqXHR.responseJSON.traceback;
        } else if (jqXHR.responseJSON && jqXHR.responseJSON.message) {
            return jqXHR.responseJSON.message;
        } else {
            return jqXHR.statusText;
        }
    };
    var log_ajax_error = function (jqXHR, status, error) {
        /**
         * log ajax failures with informative messages
         */
        var msg = "API request failed (" + jqXHR.status + "): ";
        msg += ajax_error_msg(jqXHR);
    };

    var requireCodeMirrorMode = function (mode, callback, errback) {
        /**
         * find a predefined mode or detect from CM metadata then
         * require and callback with the resolveable mode string: mime or
         * custom name
         */

        var modename = (typeof mode == "string") ? mode :
            mode.mode || mode.name;

        // simplest, cheapest check by mode name: mode may also have config
        if (CodeMirror.modes.hasOwnProperty(modename)) {
            // return the full mode object, if it has a name
            callback(mode.name ? mode : modename);
            return;
        }

        // *somehow* get back a CM.modeInfo-like object that has .mode and
        // .mime
        var info = (mode && mode.mode && mode.mime && mode) ||
            CodeMirror.findModeByName(modename) ||
            CodeMirror.findModeByExtension(modename.split(".").slice(-1)) ||
            CodeMirror.findModeByMIME(modename) ||
            {mode: modename, mime: modename};

        // require([
        //         // might want to use CodeMirror.modeURL here
        //         ['codemirror/mode', info.mode, info.mode].join('/'),
        //     ], function() {
        //       // return the original mode, as from a kernelspec on first load
        //       // or the mimetype, as for most highlighting
        //       callback(mode.name ? mode : info.mime);
        //     }, errback
        // );
        callback(mode.name ? mode : info.mime);
    };

    /** Error type for wrapped XHR errors. */
    var XHR_ERROR = 'XhrError';

    /**
     * Wraps an AJAX error as an Error object.
     */
    var wrap_ajax_error = function (jqXHR, status, error) {
        var wrapped_error = new Error(ajax_error_msg(jqXHR));
        wrapped_error.name =  XHR_ERROR;
        // provide xhr response
        wrapped_error.xhr = jqXHR;
        wrapped_error.xhr_status = status;
        wrapped_error.xhr_error = error;
        return wrapped_error;
    };

    var promising_ajax = function(url, settings) {
        /**
         * Like $.ajax, but returning an ES6 promise. success and error settings
         * will be ignored.
         */
        settings = settings || {};
        return new Promise(function(resolve, reject) {
            settings.success = function(data, status, jqXHR) {
                resolve(data);
            };
            settings.error = function(jqXHR, status, error) {
                log_ajax_error(jqXHR, status, error);
                reject(wrap_ajax_error(jqXHR, status, error));
            };
            $.ajax(url, settings);
        });
    };

    var WrappedError = function(message, error){
        /**
         * Wrappable Error class
         *
         * The Error class doesn't actually act on `this`.  Instead it always
         * returns a new instance of Error.  Here we capture that instance so we
         * can apply it's properties to `this`.
         */
        var tmp = Error.apply(this, [message]);

        // Copy the properties of the error over to this.
        var properties = Object.getOwnPropertyNames(tmp);
        for (var i = 0; i < properties.length; i++) {
            this[properties[i]] = tmp[properties[i]];
        }

        // Keep a stack of the original error messages.
        if (error instanceof WrappedError) {
            this.error_stack = error.error_stack;
        } else {
            this.error_stack = [error];
        }
        this.error_stack.push(tmp);

        return this;
    };

    WrappedError.prototype = Object.create(Error.prototype, {});


    var load_class = function(class_name, module_name, registry) {
        /**
         * Tries to load a class
         *
         * Tries to load a class from a module using require.js, if a module
         * is specified, otherwise tries to load a class from the global
         * registry, if the global registry is provided.
         */
        return new Promise(function(resolve, reject) {

            // Try loading the view module using require.js
            if (module_name) {
                require([module_name], function(module) {
                    if (module[class_name] === undefined) {
                        reject(new Error('Class '+class_name+' not found in module '+module_name));
                    } else {
                        resolve(module[class_name]);
                    }
                }, reject);
            } else {
                if (registry && registry[class_name]) {
                    resolve(registry[class_name]);
                } else {
                    reject(new Error('Class '+class_name+' not found in registry '));
                }
            }
        });
    };

    var resolve_promises_dict = function(d) {
        /**
         * Resolve a promiseful dictionary.
         * Returns a single Promise.
         */
        var keys = Object.keys(d);
        var values = [];
        keys.forEach(function(key) {
            values.push(d[key]);
        });
        return Promise.all(values).then(function(v) {
            d = {};
            for(var i=0; i<keys.length; i++) {
                d[keys[i]] = v[i];
            }
            return d;
        });
    };

    var reject = function(message, log) {
        /**
         * Creates a wrappable Promise rejection function.
         *
         * Creates a function that returns a Promise.reject with a new WrappedError
         * that has the provided message and wraps the original error that
         * caused the promise to reject.
         */
        return function(error) {
            var wrapped_error = new WrappedError(message, error);
            if (log) console.error(wrapped_error);
            return Promise.reject(wrapped_error);
        };
    };

    var typeset = function(element, text) {
        /**
         * Apply MathJax rendering to an element, and optionally set its text
         *
         * If MathJax is not available, make no changes.
         *
         * Returns the output any number of typeset elements, or undefined if
         * MathJax was not available.
         *
         * Parameters
         * ----------
         * element: Node, NodeList, or jQuery selection
         * text: option string
         */
        var $el = element.jquery ? element : $(element);
        if(arguments.length > 1){
            $el.text(text);
        }
        if(!window.MathJax){
            return;
        }
        return $el.map(function(){
            // MathJax takes a DOM node: $.map makes `this` the context
            return MathJax.Hub.Queue(["Typeset", MathJax.Hub, this]);
        });
    };

    var time = {};
    time.milliseconds = {};
    time.milliseconds.s = 1000;
    time.milliseconds.m = 60 * time.milliseconds.s;
    time.milliseconds.h = 60 * time.milliseconds.m;
    time.milliseconds.d = 24 * time.milliseconds.h;

    time.thresholds = {
        // moment.js thresholds in milliseconds
        s: moment.relativeTimeThreshold('s') * time.milliseconds.s,
        m: moment.relativeTimeThreshold('m') * time.milliseconds.m,
        h: moment.relativeTimeThreshold('h') * time.milliseconds.h,
        d: moment.relativeTimeThreshold('d') * time.milliseconds.d,
    };

    time.timeout_from_dt = function (dt) {
        /** compute a timeout based on dt

        input and output both in milliseconds

        use moment's relative time thresholds:

        - 10 seconds if in 'seconds ago' territory
        - 1 minute if in 'minutes ago'
        - 1 hour otherwise
        */
        if (dt < time.thresholds.s) {
            return 10 * time.milliseconds.s;
        } else if (dt < time.thresholds.m) {
            return time.milliseconds.m;
        } else {
            return time.milliseconds.h;
        }
    };

    var utils = {
        load_extension: load_extension,
        load_extensions: load_extensions,
        load_extensions_from_config: load_extensions_from_config,
        regex_split : regex_split,
        uuid : uuid,
        fixConsole : fixConsole,
        fixCarriageReturn : fixCarriageReturn,
        autoLinkUrls : autoLinkUrls,
        points_to_pixels : points_to_pixels,
        get_body_data : get_body_data,
        parse_url : parse_url,
        url_path_split : url_path_split,
        url_path_join : url_path_join,
        url_join_encode : url_join_encode,
        encode_uri_components : encode_uri_components,
        splitext : splitext,
        escape_html : escape_html,
        always_new : always_new,
        to_absolute_cursor_pos : to_absolute_cursor_pos,
        from_absolute_cursor_pos : from_absolute_cursor_pos,
        browser : browser,
        platform: platform,
        get_url_param: get_url_param,
        is_or_has : is_or_has,
        is_focused : is_focused,
        mergeopt: mergeopt,
        ajax_error_msg : ajax_error_msg,
        log_ajax_error : log_ajax_error,
        requireCodeMirrorMode : requireCodeMirrorMode,
        XHR_ERROR : XHR_ERROR,
        wrap_ajax_error : wrap_ajax_error,
        promising_ajax : promising_ajax,
        WrappedError: WrappedError,
        load_class: load_class,
        resolve_promises_dict: resolve_promises_dict,
        reject: reject,
        typeset: typeset,
        time: time,
    };

    return utils;
})();

var baseJsKeyboard = (function baseJsKeyboard () {
    "use strict";

    var utils = baseJsUtils;


    /**
     * Setup global keycodes and inverse keycodes.
     *
     * See http://unixpapa.com/js/key.html for a complete description. The short of
     * it is that there are different keycode sets. Firefox uses the "Mozilla keycodes"
     * and Webkit/IE use the "IE keycodes". These keycode sets are mostly the same
     * but have minor differences.
     **/

     // These apply to Firefox, (Webkit and IE)
     // This does work **only** on US keyboard.
    var _keycodes = {
        'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69, 'f': 70, 'g': 71, 'h': 72, 'i': 73,
        'j': 74, 'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79, 'p': 80, 'q': 81, 'r': 82,
        's': 83, 't': 84, 'u': 85, 'v': 86, 'w': 87, 'x': 88, 'y': 89, 'z': 90,
        '1 !': 49, '2 @': 50, '3 #': 51, '4 $': 52, '5 %': 53, '6 ^': 54,
        '7 &': 55, '8 *': 56, '9 (': 57, '0 )': 48,
        '[ {': 219, '] }': 221, '` ~': 192,  ', <': 188, '. >': 190, '/ ?': 191,
        '\\ |': 220, '\' "': 222,
        'numpad0': 96, 'numpad1': 97, 'numpad2': 98, 'numpad3': 99, 'numpad4': 100,
        'numpad5': 101, 'numpad6': 102, 'numpad7': 103, 'numpad8': 104, 'numpad9': 105,
        'multiply': 106, 'add': 107, 'subtract': 109, 'decimal': 110, 'divide': 111,
        'f1': 112, 'f2': 113, 'f3': 114, 'f4': 115, 'f5': 116, 'f6': 117, 'f7': 118,
        'f8': 119, 'f9': 120, 'f11': 122, 'f12': 123, 'f13': 124, 'f14': 125, 'f15': 126,
        'backspace': 8, 'tab': 9, 'enter': 13, 'shift': 16, 'ctrl': 17, 'alt': 18,
        'meta': 91, 'capslock': 20, 'esc': 27, 'space': 32, 'pageup': 33, 'pagedown': 34,
        'end': 35, 'home': 36, 'left': 37, 'up': 38, 'right': 39, 'down': 40,
        'insert': 45, 'delete': 46, 'numlock': 144,
    };

    // These apply to Firefox and Opera
    var _mozilla_keycodes = {
        '; :': 59, '= +': 61, '- _': 173, 'meta': 224
    };

    // This apply to Webkit and IE
    var _ie_keycodes = {
        '; :': 186, '= +': 187, '- _': 189
    };

    var browser = utils.browser[0];
    var platform = utils.platform;

    if (browser === 'Firefox' || browser === 'Opera' || browser === 'Netscape') {
        $.extend(_keycodes, _mozilla_keycodes);
    } else if (browser === 'Safari' || browser === 'Chrome' || browser === 'MSIE') {
        $.extend(_keycodes, _ie_keycodes);
    }

    var keycodes = {};
    var inv_keycodes = {};
    for (var name in _keycodes) {
        var names = name.split(' ');
        if (names.length === 1) {
            var n = names[0];
            keycodes[n] = _keycodes[n];
            inv_keycodes[_keycodes[n]] = n;
        } else {
            var primary = names[0];
            var secondary = names[1];
            keycodes[primary] = _keycodes[name];
            keycodes[secondary] = _keycodes[name];
            inv_keycodes[_keycodes[name]] = primary;
        }
    }

    var normalize_key = function (key) {
        return inv_keycodes[keycodes[key]];
    };

    var normalize_shortcut = function (shortcut) {
        /**
         * @function _normalize_shortcut
         * @private
         * return a dict containing the normalized shortcut and the number of time it should be pressed:
         *
         * Put a shortcut into normalized form:
         * 1. Make lowercase
         * 2. Replace cmd by meta
         * 3. Sort '-' separated modifiers into the order alt-ctrl-meta-shift
         * 4. Normalize keys
         **/
        if (platform === 'MacOS') {
            shortcut = shortcut.toLowerCase().replace('cmdtrl-', 'cmd-');
        } else {
            shortcut = shortcut.toLowerCase().replace('cmdtrl-', 'ctrl-');
        }

        shortcut = shortcut.toLowerCase().replace('cmd', 'meta');
        shortcut = shortcut.replace(/-$/, '_');  // catch shortcuts using '-' key
        shortcut = shortcut.replace(/,$/, 'comma');  // catch shortcuts using '-' key
        if(shortcut.indexOf(',') !== -1){
            var sht = shortcut.split(',');
            sht = sht.map(normalize_shortcut);
            return shortcut;
        }
        shortcut = shortcut.replace(/comma/g, ',');  // catch shortcuts using '-' key
        var values = shortcut.split("-");
        if (values.length === 1) {
            return normalize_key(values[0]);
        } else {
            var modifiers = values.slice(0,-1);
            var key = normalize_key(values[values.length-1]);
            modifiers.sort();
            return modifiers.join('-') + '-' + key;
        }
    };

    var shortcut_to_event = function (shortcut, type) {
        /**
         * Convert a shortcut (shift-r) to a jQuery Event object
         **/
        type = type || 'keydown';
        shortcut = normalize_shortcut(shortcut);
        shortcut = shortcut.replace(/-$/, '_');  // catch shortcuts using '-' key
        var values = shortcut.split("-");
        var modifiers = values.slice(0,-1);
        var key = values[values.length-1];
        var opts = {which: keycodes[key]};
        if (modifiers.indexOf('alt') !== -1) {opts.altKey = true;}
        if (modifiers.indexOf('ctrl') !== -1) {opts.ctrlKey = true;}
        if (modifiers.indexOf('meta') !== -1) {opts.metaKey = true;}
        if (modifiers.indexOf('shift') !== -1) {opts.shiftKey = true;}
        return $.Event(type, opts);
    };

    var only_modifier_event = function(event){
        /**
         * Return `true` if the event only contains modifiers keys.
         * false otherwise
         **/
        var key = inv_keycodes[event.which];
        return ((event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
         (key === 'alt'|| key === 'ctrl'|| key === 'meta'|| key === 'shift'));

    };

    var event_to_shortcut = function (event) {
        /**
         * Convert a jQuery Event object to a normalized shortcut string (shift-r)
         **/
        var shortcut = '';
        var key = inv_keycodes[event.which];
        if (event.altKey && key !== 'alt') {shortcut += 'alt-';}
        if (event.ctrlKey && key !== 'ctrl') {shortcut += 'ctrl-';}
        if (event.metaKey && key !== 'meta') {shortcut += 'meta-';}
        if (event.shiftKey && key !== 'shift') {shortcut += 'shift-';}
        shortcut += key;
        return shortcut;
    };

    // Shortcut manager class

    var ShortcutManager = function (delay, events, actions, env) {
        /**
         * A class to deal with keyboard event and shortcut
         *
         * @class ShortcutManager
         * @constructor
         */
        this._shortcuts = {};
        this.delay = delay || 800; // delay in milliseconds
        this.events = events;
        this.actions = actions;
        this.actions.extend_env(env);
        this._queue = [];
        this._cleartimeout = null;
        Object.seal(this);
    };

    ShortcutManager.prototype.clearsoon = function(){
        /**
         * Clear the pending shortcut soon, and cancel previous clearing
         * that might be registered.
         **/
         var that = this;
         clearTimeout(this._cleartimeout);
         this._cleartimeout = setTimeout(function(){that.clearqueue();}, this.delay);
    };


    ShortcutManager.prototype.clearqueue = function(){
        /**
         * clear the pending shortcut sequence now.
         **/
        this._queue = [];
        clearTimeout(this._cleartimeout);
    };


    var flatten_shorttree = function(tree){
        /**
         * Flatten a tree of shortcut sequences.
         * use full to iterate over all the key/values of available shortcuts.
         **/
        var  dct = {};
        for(var key in tree){
            var value = tree[key];
            if(typeof(value) === 'string'){
                dct[key] = value;
            } else {
                var ftree=flatten_shorttree(value);
                for(var subkey in ftree){
                    dct[key+','+subkey] = ftree[subkey];
                }
            }
        }
        return dct;
    };

    ShortcutManager.prototype.help = function () {
        var help = [];
        var ftree = flatten_shorttree(this._shortcuts);
        for (var shortcut in ftree) {
            var action = this.actions.get(ftree[shortcut]);
            var help_string = action.help||'== no help ==';
            var help_index = action.help_index;
            if (help_string) {
                var shortstring = (action.shortstring||shortcut);
                help.push({
                    shortcut: shortstring,
                    help: help_string,
                    help_index: help_index}
                );
            }
        }
        help.sort(function (a, b) {
            if (a.help_index === b.help_index) {
                return 0;
            }
            if (a.help_index === undefined || a.help_index > b.help_index){
                return 1;
            }
            return -1;
        });
        return help;
    };

    ShortcutManager.prototype.clear_shortcuts = function () {
        this._shortcuts = {};
    };

    ShortcutManager.prototype.get_shortcut = function (shortcut){
        /**
         * return a node of the shortcut tree which an action name (string) if leaf,
         * and an object with `object.subtree===true`
         **/
        if(typeof(shortcut) === 'string'){
            shortcut = shortcut.split(',');
        }

        return this._get_leaf(shortcut, this._shortcuts);
    };


    ShortcutManager.prototype._get_leaf = function(shortcut_array, tree){
        /**
         * @private
         * find a leaf/node in a subtree of the keyboard shortcut
         *
         **/
        if(shortcut_array.length === 1){
            return tree[shortcut_array[0]];
        } else if(  typeof(tree[shortcut_array[0]]) !== 'string'){
            return this._get_leaf(shortcut_array.slice(1), tree[shortcut_array[0]]);
        }
        return null;
    };

    ShortcutManager.prototype.set_shortcut = function( shortcut, action_name){
        if( typeof(action_name) !== 'string'){throw new Error('action is not a string', action_name);}
        if( typeof(shortcut) === 'string'){
            shortcut = shortcut.split(',');
        }
        return this._set_leaf(shortcut, action_name, this._shortcuts);
    };

    ShortcutManager.prototype._is_leaf = function(shortcut_array, tree){
        if(shortcut_array.length === 1){
           return(typeof(tree[shortcut_array[0]]) === 'string');
        } else {
            var subtree = tree[shortcut_array[0]];
            return this._is_leaf(shortcut_array.slice(1), subtree );
        }
    };

    ShortcutManager.prototype._remove_leaf = function(shortcut_array, tree, allow_node){
        if(shortcut_array.length === 1){
            var current_node = tree[shortcut_array[0]];
            if(typeof(current_node) === 'string'){
                delete tree[shortcut_array[0]];
            } else {
                throw('try to delete non-leaf');
            }
        } else {
            this._remove_leaf(shortcut_array.slice(1),  tree[shortcut_array[0]], allow_node);
            if(Object.keys(tree[shortcut_array[0]]).length === 0){
                delete tree[shortcut_array[0]];
            }
        }
    };

    ShortcutManager.prototype._set_leaf = function(shortcut_array, action_name, tree){
        var current_node = tree[shortcut_array[0]];
        if(shortcut_array.length === 1){
            if(current_node !== undefined && typeof(current_node) !== 'string'){
                console.warn('[warning], you are overriting a long shortcut with a shorter one');
            }
            tree[shortcut_array[0]] = action_name;
            return true;
        } else {
            if(typeof(current_node) === 'string'){
                console.warn('you are trying to set a shortcut that will be shadowed'+
                             'by a more specific one. Aborting for :', action_name, 'the follwing '+
                             'will take precedence', current_node);
                return false;
            } else {
                tree[shortcut_array[0]] = tree[shortcut_array[0]]||{};
            }
            this._set_leaf(shortcut_array.slice(1), action_name, tree[shortcut_array[0]]);
            return true;
        }
    };

    ShortcutManager.prototype.call_handler = function (event) {
        /**
         * Call the corresponding shortcut handler for a keyboard event
         * @method call_handler
         * @return {Boolean} `true|false`, `false` if no handler was found, otherwise the  value return by the handler.
         * @param event {event}
         *
         * given an event, call the corresponding shortcut.
         * return false is event wan handled, true otherwise
         * in any case returning false stop event propagation
         **/


        this.clearsoon();
        if(only_modifier_event(event)){
            return true;
        }
        var shortcut = event_to_shortcut(event);
        this._queue.push(shortcut);
        var action_name = this.get_shortcut(this._queue);

        if (typeof(action_name) === 'undefined'|| action_name === null){
            this.clearqueue();
            return true;
        }

        if (this.actions.exists(action_name)) {
            event.preventDefault();
            this.clearqueue();
            return this.actions.call(action_name, event);
        }

        return false;
    };


    ShortcutManager.prototype.handles = function (event) {
        var shortcut = event_to_shortcut(event);
        var action_name = this.get_shortcut(this._queue.concat(shortcut));
        return (typeof(action_name) !== 'undefined');
    };

    var keyboard = {
        keycodes : keycodes,
        inv_keycodes : inv_keycodes,
        ShortcutManager : ShortcutManager,
        normalize_key : normalize_key,
        normalize_shortcut : normalize_shortcut,
        shortcut_to_event : shortcut_to_event,
        event_to_shortcut : event_to_shortcut,
    };

    return keyboard;
})();

var notebookJsKeyboardManager = (function notebookJsKeyboardManager () {
    "use strict";

    var keyboard = baseJsKeyboard;
    var utils = baseJsUtils;

    // Main keyboard manager for the notebook
    var keycodes = keyboard.keycodes;

    var KeyboardManager = function (options) {
        /**
         * A class to deal with keyboard event and shortcut
         *
         * @class KeyboardManager
         * @constructor
         * @param options {dict} Dictionary of keyword arguments :
         *    @param options.events {$(Events)} instance
         *    @param options.pager: {Pager}  pager instance
         */
        this.mode = 'command';
        this.enabled = true;
        this.pager = options.pager;
        this.quick_help = undefined;
        this.notebook = undefined;
        this.last_mode = undefined;
        this.bind_events();
        this.env = {pager:this.pager};
        this.actions = options.actions;
        this.command_shortcuts = new keyboard.ShortcutManager(undefined, options.events, this.actions, this.env );
        this.edit_shortcuts = new keyboard.ShortcutManager(undefined, options.events, this.actions, this.env);
        Object.seal(this);
    };

    KeyboardManager.prototype.bind_events = function () {
        var that = this;
        $(document).keydown(function (event) {
            if(event._ipkmIgnore===true||(event.originalEvent||{})._ipkmIgnore===true){
                return false;
            }
            return that.handle_keydown(event);
        });
    };

    KeyboardManager.prototype.set_notebook = function (notebook) {
        this.notebook = notebook;
        this.actions.extend_env({notebook:notebook});
    };

    KeyboardManager.prototype.set_quickhelp = function (notebook) {
        this.actions.extend_env({quick_help:notebook});
    };


    KeyboardManager.prototype.handle_keydown = function (event) {
        /**
         *  returning false from this will stop event propagation
         **/

        if (event.which === keycodes.esc) {
            // Intercept escape at highest level to avoid closing
            // websocket connection with firefox
            event.preventDefault();
        }

        if (!this.enabled) {
            if (event.which === keycodes.esc) {
                this.notebook.command_mode();
                return false;
            }
            return true;
        }

        if (this.mode === 'edit') {
            return this.edit_shortcuts.call_handler(event);
        } else if (this.mode === 'command') {
            return this.command_shortcuts.call_handler(event);
        }
        return true;
    };

    KeyboardManager.prototype.edit_mode = function () {
        this.last_mode = this.mode;
        this.mode = 'edit';
    };

    KeyboardManager.prototype.command_mode = function () {
        this.last_mode = this.mode;
        this.mode = 'command';
    };

    KeyboardManager.prototype.enable = function () {
        this.enabled = true;
    };

    KeyboardManager.prototype.disable = function () {
        this.enabled = false;
    };

    KeyboardManager.prototype.register_events = function (e) {
        e = $(e);
        var that = this;
        var handle_focus = function () {
            that.disable();
        };
        var handle_blur = function () {
            that.enable();
        };
        e.on('focusin', handle_focus);
        e.on('focusout', handle_blur);
        // TODO: Very strange. The focusout event does not seem fire for the
        // bootstrap textboxes on FF25&26...  This works around that by
        // registering focus and blur events recursively on all inputs within
        // registered element.
        e.find('input').blur(handle_blur);
        e.on('DOMNodeInserted', function (event) {
            var target = $(event.target);
            if (target.is('input')) {
                target.blur(handle_blur);
            } else {
                target.find('input').blur(handle_blur);
            }
          });
        // There are times (raw_input) where we remove the element from the DOM before
        // focusout is called. In this case we bind to the remove event of jQueryUI,
        // which gets triggered upon removal, iff it is focused at the time.
        // is_focused must be used to check for the case where an element within
        // the element being removed is focused.
        e.on('remove', function () {
            if (utils.is_focused(e[0])) {
                that.enable();
            }
        });
    };

    return {'KeyboardManager': KeyboardManager};
})();

var notebookJsAction = (function notebookJsAction() {
    "use strict";

    var ActionHandler = function (env) {
        this.env = env || {};
        Object.seal(this);
    };

    /**
     *  A bunch of predefined `Simple Actions` used by Jupyter.
     *  `Simple Actions` have the following keys:
     *  help (optional): a short string the describe the action.
     *      will be used in various context, like as menu name, tool tips on buttons,
     *      and short description in help menu.
     *  help_index (optional): a string used to sort action in help menu.
     *  icon (optional): a short string that represent the icon that have to be used with this
     *  action. this should mainly correspond to a Font_awesome class.
     *  handler : a function which is called when the action is activated. It will receive at first parameter
     *      a dictionary containing various handle to element of the notebook.
     *
     *  action need to be registered with a **name** that can be use to refer to this action.
     *
     *
     *  if `help` is not provided it will be derived by replacing any dash by space
     *  in the **name** of the action. It is advised to provide a prefix to action name to
     *  avoid conflict the prefix should be all lowercase and end with a dot `.`
     *  in the absence of a prefix the behavior of the action is undefined.
     *
     *  All action provided by Jupyter are prefixed with `ipython.`.
     *
     *  One can register extra actions or replace an existing action with another one is possible
     *  but is considered undefined behavior.
     *
     **/
    var _actions = {
        'go-to-command-mode': {
            help    : 'command mode',
            help_index : 'aa',
            handler : function (env) {
                env.notebook.command_mode();
            }
        },
        'split-cell-at-cursor': {
            help    : 'split cell',
            help_index : 'ea',
            handler : function (env) {
                env.notebook.split_cell();
            }
        },
        'enter-edit-mode' : {
            help_index : 'aa',
            handler : function (env) {
                env.notebook.edit_mode();
            }
        },
        'select-previous-cell' : {
            help: 'select cell above',
            help_index : 'da',
            handler : function (env) {
                var index = env.notebook.get_selected_index();
                if (index !== 0 && index !== null) {
                    env.notebook.select_prev();
                    env.notebook.focus_cell();
                }
            }
        },
        'select-next-cell' : {
            help: 'select cell below',
            help_index : 'db',
            handler : function (env) {
                var index = env.notebook.get_selected_index();
                if (index !== (env.notebook.ncells()-1) && index !== null) {
                    env.notebook.select_next();
                    env.notebook.focus_cell();
                }
            }
        },
        'cut-selected-cell' : {
            icon: 'fa-cut',
            help_index : 'ee',
            handler : function (env) {
                var index = env.notebook.get_selected_index();
                env.notebook.cut_cell();
                env.notebook.select(index);
            }
        },
        'copy-selected-cell' : {
            icon: 'fa-copy',
            help_index : 'ef',
            handler : function (env) {
                env.notebook.copy_cell();
            }
        },
        'paste-cell-before' : {
            help: 'paste cell above',
            help_index : 'eg',
            handler : function (env) {
                env.notebook.paste_cell_above();
            }
        },
        'paste-cell-after' : {
            help: 'paste cell below',
            icon: 'fa-paste',
            help_index : 'eh',
            handler : function (env) {
                env.notebook.paste_cell_below();
            }
        },
        'insert-cell-before' : {
            help: 'insert cell above',
            help_index : 'ec',
            handler : function (env) {
                env.notebook.insert_cell_above();
                env.notebook.select_prev();
                env.notebook.focus_cell();
            }
        },
        'insert-cell-after' : {
            help: 'insert cell below',
            icon : 'fa-plus',
            help_index : 'ed',
            handler : function (env) {
                env.notebook.insert_cell_below();
                env.notebook.select_next();
                env.notebook.focus_cell();
            }
        },
        'change-selected-cell-to-code-cell' : {
            help    : 'to code',
            help_index : 'ca',
            handler : function (env) {
                env.notebook.to_code();
            }
        },
        'change-selected-cell-to-markdown-cell' : {
            help    : 'to markdown',
            help_index : 'cb',
            handler : function (env) {
                env.notebook.to_markdown();
            }
        },
        'change-selected-cell-to-raw-cell' : {
            help    : 'to raw',
            help_index : 'cc',
            handler : function (env) {
                env.notebook.to_raw();
            }
        },
        'change-selected-cell-to-heading-1' : {
            help    : 'to heading 1',
            help_index : 'cd',
            handler : function (env) {
                env.notebook.to_heading(undefined, 1);
            }
        },
        'change-selected-cell-to-heading-2' : {
            help    : 'to heading 2',
            help_index : 'ce',
            handler : function (env) {
                env.notebook.to_heading(undefined, 2);
            }
        },
        'change-selected-cell-to-heading-3' : {
            help    : 'to heading 3',
            help_index : 'cf',
            handler : function (env) {
                env.notebook.to_heading(undefined, 3);
            }
        },
        'change-selected-cell-to-heading-4' : {
            help    : 'to heading 4',
            help_index : 'cg',
            handler : function (env) {
                env.notebook.to_heading(undefined, 4);
            }
        },
        'change-selected-cell-to-heading-5' : {
            help    : 'to heading 5',
            help_index : 'ch',
            handler : function (env) {
                env.notebook.to_heading(undefined, 5);
            }
        },
        'change-selected-cell-to-heading-6' : {
            help    : 'to heading 6',
            help_index : 'ci',
            handler : function (env) {
                env.notebook.to_heading(undefined, 6);
            }
        },
        'toggle-output-visibility-selected-cell' : {
            help    : 'toggle output',
            help_index : 'gb',
            handler : function (env) {
                env.notebook.toggle_output();
            }
        },
        'toggle-output-scrolling-selected-cell' : {
            help    : 'toggle output scrolling',
            help_index : 'gc',
            handler : function (env) {
                env.notebook.toggle_output_scroll();
            }
        },
        'move-selected-cell-down' : {
            icon: 'fa-arrow-down',
            help_index : 'eb',
            handler : function (env) {
                env.notebook.move_cell_down();
            }
        },
        'move-selected-cell-up' : {
            icon: 'fa-arrow-up',
            help_index : 'ea',
            handler : function (env) {
                env.notebook.move_cell_up();
            }
        },
        'toggle-line-number-selected-cell' : {
            help    : 'toggle line numbers',
            help_index : 'ga',
            handler : function (env) {
                env.notebook.cell_toggle_line_numbers();
            }
        },
        'show-keyboard-shortcut-help-dialog' : {
            help_index : 'ge',
            handler : function (env) {
                env.quick_help.show_keyboard_shortcuts();
            }
        },
        'delete-cell': {
            help: 'delete selected cell',
            help_index : 'ej',
            handler : function (env) {
                env.notebook.delete_cell();
            }
        },
        'interrupt-kernel':{
            icon: 'fa-stop',
            help_index : 'ha',
            handler : function (env) {
                env.notebook.kernel.interrupt();
            }
        },
        'undo-last-cell-deletion' : {
            help_index : 'ei',
            handler : function (env) {
                env.notebook.undelete_cell();
            }
        },
        'merge-selected-cell-with-cell-after' : {
            help    : 'merge cell below',
            help_index : 'ek',
            handler : function (env) {
                env.notebook.merge_cell_below();
            }
        },
        'close-pager' : {
            help_index : 'gd',
            handler : function (env) {
                env.pager.collapse();
            }
        }

    };

    /**
     * A bunch of `Advance actions` for Jupyter.
     * Cf `Simple Action` plus the following properties.
     *
     * handler: first argument of the handler is the event that triggerd the action
     *      (typically keypress). The handler is responsible for any modification of the
     *      event and event propagation.
     *      Is also responsible for returning false if the event have to be further ignored,
     *      true, to tell keyboard manager that it ignored the event.
     *
     *      the second parameter of the handler is the environemnt passed to Simple Actions
     *
     **/
    var custom_ignore = {
        'ignore':{
            handler : function () {
                return true;
            }
        },
        'move-cursor-up-or-previous-cell':{
            handler : function (env, event) {
                var index = env.notebook.get_selected_index();
                var cell = env.notebook.get_cell(index);
                var cm = env.notebook.get_selected_cell().code_mirror;
                var cur = cm.getCursor();
                if (cell && cell.at_top() && index !== 0 && cur.ch === 0) {
                    if(event){
                        event.preventDefault();
                    }
                    env.notebook.command_mode();
                    env.notebook.select_prev();
                    env.notebook.edit_mode();
                    cm = env.notebook.get_selected_cell().code_mirror;
                    cm.setCursor(cm.lastLine(), 0);
                }
                return false;
            }
        },
        'move-cursor-down-or-next-cell':{
            handler : function (env, event) {
                var index = env.notebook.get_selected_index();
                var cell = env.notebook.get_cell(index);
                if (cell.at_bottom() && index !== (env.notebook.ncells()-1)) {
                    if(event){
                        event.preventDefault();
                    }
                    env.notebook.command_mode();
                    env.notebook.select_next();
                    env.notebook.edit_mode();
                    var cm = env.notebook.get_selected_cell().code_mirror;
                    cm.setCursor(0, 0);
                }
                return false;
            }
        },
        'scroll-down': {
            handler: function(env, event) {
                if(event){
                    event.preventDefault();
                }
                return env.notebook.scroll_manager.scroll(1);
            },
        },
        'scroll-up': {
            handler: function(env, event) {
                if(event){
                    event.preventDefault();
                }
                return env.notebook.scroll_manager.scroll(-1);
            },
        },
        'scroll-cell-center': {
            help: "Scroll the current cell to the center",
            handler: function (env, event) {
                if(event){
                    event.preventDefault();
                }
                var cell = env.notebook.get_selected_index();
                return env.notebook.scroll_cell_percent(cell, 50, 0);
            }
        },
        'scroll-cell-top': {
            help: "Scroll the current cell to the top",
            handler: function (env, event) {
                if(event){
                    event.preventDefault();
                }
                var cell = env.notebook.get_selected_index();
                return env.notebook.scroll_cell_percent(cell, 0, 0);
            }
        },
        'save-notebook':{
            help: "Save and Checkpoint",
            help_index : 'fb',
            icon: 'fa-save',
            handler : function (env, event) {
                env.notebook.save_checkpoint();
                if(event){
                    event.preventDefault();
                }
                return false;
            }
        },
    };

    // private stuff that prepend `.ipython` to actions names
    // and uniformize/fill in missing pieces in of an action.
    var _prepare_handler = function(registry, subkey, source){
        registry['ipython.'+subkey] = {};
        registry['ipython.'+subkey].help = source[subkey].help||subkey.replace(/-/g,' ');
        registry['ipython.'+subkey].help_index = source[subkey].help_index;
        registry['ipython.'+subkey].icon = source[subkey].icon;
        return source[subkey].handler;
    };

    // Will actually generate/register all the Jupyter actions
    var fun = function(){
        var final_actions = {};
        var k;
        for(k in _actions){
            if(_actions.hasOwnProperty(k)){
                // Js closure are function level not block level need to wrap in a IIFE
                // and append ipython to event name these things do intercept event so are wrapped
                // in a function that return false.
                var handler = _prepare_handler(final_actions, k, _actions);
                (function(key, handler){
                    final_actions['ipython.'+key].handler = function(env, event){
                        handler(env);
                        if(event){
                            event.preventDefault();
                        }
                        return false;
                    };
                })(k, handler);
            }
        }

        for(k in custom_ignore){
            // Js closure are function level not block level need to wrap in a IIFE
            // same as above, but decide for themselves wether or not they intercept events.
            if(custom_ignore.hasOwnProperty(k)){
                var handler = _prepare_handler(final_actions, k, custom_ignore);
                (function(key, handler){
                    final_actions['ipython.'+key].handler = function(env, event){
                        return handler(env, event);
                    };
                })(k, handler);
            }
        }

        return final_actions;
    };
    ActionHandler.prototype._actions = fun();


    /**
     *  extend the environment variable that will be pass to handlers
     **/
    ActionHandler.prototype.extend_env = function(env){
        for(var k in env){
            this.env[k] = env[k];
        }
    };

    ActionHandler.prototype.register = function(action, name, prefix){
        /**
         * Register an `action` with an optional name and prefix.
         *
         * if name and prefix are not given they will be determined automatically.
         * if action if just a `function` it will be wrapped in an anonymous action.
         *
         * @return the full name to access this action .
         **/
        action = this.normalise(action);
        if( !name ){
            name = 'autogenerated-'+String(action.handler);
        }
        prefix = prefix || 'auto';
        var full_name = prefix+'.'+name;
        this._actions[full_name] = action;
        return full_name;

    };


    ActionHandler.prototype.normalise = function(data){
        /**
         * given an `action` or `function`, return a normalised `action`
         * by setting all known attributes and removing unknown attributes;
         **/
        if(typeof(data) === 'function'){
            data = {handler:data};
        }
        if(typeof(data.handler) !== 'function'){
            throw('unknown datatype, cannot register');
        }
        var _data = data;
        data = {};
        data.handler = _data.handler;
        data.help = _data.help || '';
        data.icon = _data.icon || '';
        data.help_index = _data.help_index || '';
        return data;
    };

    ActionHandler.prototype.get_name = function(name_or_data){
        /**
         * given an `action` or `name` of a action, return the name attached to this action.
         * if given the name of and corresponding actions does not exist in registry, return `null`.
         **/

        if(typeof(name_or_data) === 'string'){
            if(this.exists(name_or_data)){
                return name_or_data;
            } else {
                return null;
            }
        } else {
            return this.register(name_or_data);
        }
    };

    ActionHandler.prototype.get = function(name){
        return this._actions[name];
    };

    ActionHandler.prototype.call = function(name, event, env){
        return this._actions[name].handler(env|| this.env, event);
    };

    ActionHandler.prototype.exists = function(name){
        return (typeof(this._actions[name]) !== 'undefined');
    };

    return {init:ActionHandler};

})();

var notebookJsPager = (function notebookJsPager() {
    "use strict";

    var utils = baseJsUtils;

    var Pager = function (pager_selector, options) {
        /**
         * Constructor
         *
         * Parameters:
         *  pager_selector: string
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         */
        this.events = options.events;
        this.pager_element = $(pager_selector);
        this.pager_button_area = $('#pager-button-area');
        this._default_end_space = 100;
        this.pager_element.resizable({handles: 'n', resize: $.proxy(this._resize, this)});
        this.expanded = false;
        this.create_button_area();
        this.bind_events();
    };

    Pager.prototype.create_button_area = function(){
        var that = this;
        this.pager_button_area.append(
            $('<a>').attr('role', "button")
                    .attr('title',"Open the pager in an external window")
                    .addClass('ui-button')
                    .click(function(){that.detach();})
                    .append(
                        $('<span>').addClass("ui-icon ui-icon-extlink")
                    )
        );
        this.pager_button_area.append(
            $('<a>').attr('role', "button")
                    .attr('title',"Close the pager")
                    .addClass('ui-button')
                    .click(function(){that.collapse();})
                    .append(
                        $('<span>').addClass("ui-icon ui-icon-close")
                    )
        );
    };


    Pager.prototype.bind_events = function () {
        var that = this;

        this.pager_element.bind('collapse_pager', function (event, extrap) {
            // Animate hiding of the pager.
            var time = (extrap && extrap.duration) ? extrap.duration : 'fast';
            that.pager_element.animate({
                height: 'toggle'
            }, {
                duration: time,
                done: function() {
                    $('.end_space').css('height', that._default_end_space);
                }
            });
        });

        this.pager_element.bind('expand_pager', function (event, extrap) {
            // Clear the pager's height attr if it's set.  This allows the
            // pager to size itself according to its contents.
            that.pager_element.height('initial');

            // Animate the showing of the pager
            var time = (extrap && extrap.duration) ? extrap.duration : 'fast';
            that.pager_element.show(time, function() {
                // Explicitly set pager height once the pager has shown itself.
                // This allows the pager-contents div to use percentage sizing.
                that.pager_element.height(that.pager_element.height());
                that._resize();
            });
        });

        this.events.on('open_with_text.Pager', function (event, payload) {
            // FIXME: support other mime types with generic mimebundle display
            // mechanism
            if (payload.data['text/html'] && payload.data['text/html'] !== "") {
                that.clear();
                that.expand();
                that.append(payload.data['text/html']);
            } else if (payload.data['text/plain'] && payload.data['text/plain'] !== "") {
                that.clear();
                that.expand();
                that.append_text(payload.data['text/plain']);
            }
        });
    };


    Pager.prototype.collapse = function (extrap) {
        if (this.expanded === true) {
            this.expanded = false;
            this.pager_element.trigger('collapse_pager', extrap);
        }
    };


    Pager.prototype.expand = function (extrap) {
        if (this.expanded !== true) {
            this.expanded = true;
            this.pager_element.trigger('expand_pager', extrap);
        }
    };


    Pager.prototype.toggle = function () {
        if (this.expanded === true) {
            this.collapse();
        } else {
            this.expand();
        }
    };


    Pager.prototype.clear = function (text) {
        this.pager_element.find(".container").empty();
    };

    Pager.prototype.detach = function(){
        var w = window.open("","_blank");
        $(w.document.head)
        .append(
                $('<link>')
                .attr('rel',"stylesheet")
                .attr('href',"/static/css/notebook.css")
                .attr('type',"text/css")
        )
        .append(
                $('<title>').text("Jupyter Pager")
        );
        var pager_body = $(w.document.body);
        pager_body.css('overflow','scroll');

        pager_body.append(this.pager_element.clone().children());
        w.document.close();
        this.collapse();
    };

    Pager.prototype.append_text = function (text) {
        /**
         * The only user content injected with this HTML call is escaped by
         * the fixConsole() method.
         */
        this.pager_element.find(".container").append($('<pre/>').html(utils.fixCarriageReturn(utils.fixConsole(text))));
    };


    Pager.prototype._resize = function() {
        /**
         * Update document based on pager size.
         */

        // Make sure the padding at the end of the notebook is large
        // enough that the user can scroll to the bottom of the
        // notebook.
        $('.end_space').css('height', Math.max(this.pager_element.height(), this._default_end_space));
    };

    return {'Pager': Pager};
})();

var baseJsEvent = (function baseJsEvent() {
    "use strict";

    var Events = function () {};

    var events = new Events();

    // Backwards compatability.
    IPython.Events = Events;
    IPython.events = events;

    return $([events]);
})();

var baseJsPage = (function baseJsPage() {
    "use strict";

    var events = baseJsEvent;

    var Page = function () {
        this.bind_events();
    };

    Page.prototype.bind_events = function () {
        // resize site on:
        // - window resize
        // - header change
        // - page load
        var _handle_resize = $.proxy(this._resize_site, this);

        $(window).resize(_handle_resize);

        // On document ready, resize codemirror.
        $(document).ready(_handle_resize);
        events.on('resize-header.Page', _handle_resize);
    };

    Page.prototype.show = function () {
        /**
         * The header and site divs start out hidden to prevent FLOUC.
         * Main scripts should call this method after styling everything.
         */
        this.show_header();
        this.show_site();
    };

    Page.prototype.show_header = function () {
        /**
         * The header and site divs start out hidden to prevent FLOUC.
         * Main scripts should call this method after styling everything.
         * TODO: selector are hardcoded, pass as constructor argument
         */
        $('div#header').css('display','block');
    };

    Page.prototype.show_site = function () {
        /**
         * The header and site divs start out hidden to prevent FLOUC.
         * Main scripts should call this method after styling everything.
         * TODO: selector are hardcoded, pass as constructor argument
         */
        $('div#site').css('display', 'block');
        this._resize_site();
    };

    Page.prototype._resize_site = function() {
        // Update the site's size.
        $('div#site').height($(window).height() - $('#header').height());
    };

    return {'Page': Page};
})();

var baseJsDialog = (function baseJsDialog() {
    "use strict";

    // var CodeMirror = require('codemirror/lib/codemirror');

    /**
     * A wrapper around bootstrap modal for easier use
     * Pass it an option dictionary with the following properties:
     *
     *    - body : <string> or <DOM node>, main content of the dialog
     *            if pass a <string> it will be wrapped in a p tag and
     *            html element escaped, unless you specify sanitize=false
     *            option.
     *    - title : Dialog title, default to empty string.
     *    - buttons : dict of btn_options who keys are button label.
     *            see btn_options below for description
     *    - open : callback to trigger on dialog open.
     *    - destroy:
     *    - notebook : notebook instance
     *    - keyboard_manager: keyboard manager instance.
     *
     *  Unlike bootstrap modals, the backdrop options is set by default
     *  to 'static'.
     *
     *  The rest of the options are passed as is to bootstrap modals.
     *
     *  btn_options: dict with the following property:
     *
     *    - click : callback to trigger on click
     *    - class : css classes to add to button.
     *
     *
     *
     **/
    var modal = function (options) {

        var modal = $("<div/>")
            .addClass("modal")
            .addClass("fade")
            .attr("role", "dialog");
        var dialog = $("<div/>")
            .addClass("modal-dialog")
            .appendTo(modal);
        var dialog_content = $("<div/>")
            .addClass("modal-content")
            .appendTo(dialog);
        if(typeof(options.body) === 'string' && options.sanitize !== false){
            options.body = $("<p/>").text(options.body)
        }
        dialog_content.append(
            $("<div/>")
                .addClass("modal-header")
                .append($("<button>")
                    .attr("type", "button")
                    .addClass("close")
                    .attr("data-dismiss", "modal")
                    .attr("aria-hidden", "true")
                    .html("&times;")
                ).append(
                    $("<h4/>")
                        .addClass('modal-title')
                        .text(options.title || "")
                )
        ).append(
            $("<div/>").addClass("modal-body").append(
                options.body || $("<p/>")
            )
        );

        var footer = $("<div/>").addClass("modal-footer");

        for (var label in options.buttons) {
            var btn_opts = options.buttons[label];
            var button = $("<button/>")
                .addClass("btn btn-default btn-sm")
                .attr("data-dismiss", "modal")
                .text(label);
            if (btn_opts.click) {
                button.click($.proxy(btn_opts.click, dialog_content));
            }
            if (btn_opts.class) {
                button.addClass(btn_opts.class);
            }
            footer.append(button);
        }
        dialog_content.append(footer);
        // hook up on-open event
        modal.on("shown.bs.modal", function() {
            setTimeout(function() {
                footer.find("button").last().focus();
                if (options.open) {
                    $.proxy(options.open, modal)();
                }
            }, 0);
        });

        // destroy modal on hide, unless explicitly asked not to
        if (options.destroy === undefined || options.destroy) {
            modal.on("hidden.bs.modal", function () {
                modal.remove();
            });
        }
        modal.on("hidden.bs.modal", function () {
            if (options.notebook) {
                var cell = options.notebook.get_selected_cell();
                if (cell) cell.select();
            }
            if (options.keyboard_manager) {
                options.keyboard_manager.enable();
                options.keyboard_manager.command_mode();
            }
        });

        if (options.keyboard_manager) {
            options.keyboard_manager.disable();
        }

        options.backdrop = options.backdrop || 'static';

        return modal.modal(options);
    };

    var kernel_modal = function (options) {
        /**
         * only one kernel dialog should be open at a time -- but
         * other modal dialogs can still be open
         */
        $('.kernel-modal').modal('hide');
        var dialog = modal(options);
        dialog.addClass('kernel-modal');
        return dialog;
    };

    var edit_metadata = function (options) {
        options.name = options.name || "Cell";
        var error_div = $('<div/>').css('color', 'red');
        var message =
            "Manually edit the JSON below to manipulate the metadata for this " + options.name + "." +
            " We recommend putting custom metadata attributes in an appropriately named sub-structure," +
            " so they don't conflict with those of others.";

        var textarea = $('<textarea/>')
            .attr('rows', '13')
            .attr('cols', '80')
            .attr('name', 'metadata')
            .text(JSON.stringify(options.md || {}, null, 2));

        var dialogform = $('<div/>').attr('title', 'Edit the metadata')
            .append(
                $('<form/>').append(
                    $('<fieldset/>').append(
                        $('<label/>')
                        .attr('for','metadata')
                        .text(message)
                        )
                        .append(error_div)
                        .append($('<br/>'))
                        .append(textarea)
                    )
            );
        var editor = CodeMirror.fromTextArea(textarea[0], {
            lineNumbers: true,
            matchBrackets: true,
            indentUnit: 2,
            autoIndent: true,
            mode: 'application/json',
        });
        var modal_obj = modal({
            title: "Edit " + options.name + " Metadata",
            body: dialogform,
            buttons: {
                OK: { class : "btn-primary",
                    click: function() {
                        /**
                         * validate json and set it
                         */
                        var new_md;
                        try {
                            new_md = JSON.parse(editor.getValue());
                        } catch(e) {
                            console.log(e);
                            error_div.text('WARNING: Could not save invalid JSON.');
                            return false;
                        }
                        options.callback(new_md);
                    }
                },
                Cancel: {}
            },
            notebook: options.notebook,
            keyboard_manager: options.keyboard_manager,
        });

        modal_obj.on('shown.bs.modal', function(){ editor.refresh(); });
    };

    var dialog = {
        modal : modal,
        kernel_modal : kernel_modal,
        edit_metadata : edit_metadata,
    };

    return dialog;
})();

var notebookContents = (function notebookContents() {
    "use strict";

    var utils = baseJsUtils;

    var Contents = function(options) {
        /**
         * Constructor
         *
         * Preliminary documentation for the REST API is at
         * https://github.com/ipython/ipython/wiki/IPEP-27%3A-Contents-Service
         *
         * A contents handles passing file operations
         * to the back-end.  This includes checkpointing
         * with the normal file operations.
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          base_url: string
         */
        this.base_url = options.base_url;
    };

    /** Error type */
    Contents.DIRECTORY_NOT_EMPTY_ERROR = 'DirectoryNotEmptyError';

    Contents.DirectoryNotEmptyError = function() {
        // Constructor
        //
        // An error representing the result of attempting to delete a non-empty
        // directory.
        this.message = 'A directory must be empty before being deleted.';
    };

    Contents.DirectoryNotEmptyError.prototype = Object.create(Error.prototype);
    Contents.DirectoryNotEmptyError.prototype.name =
        Contents.DIRECTORY_NOT_EMPTY_ERROR;


    Contents.prototype.api_url = function() {
        var url_parts = [this.base_url, 'api/contents'].concat(
                                Array.prototype.slice.apply(arguments));
        return utils.url_join_encode.apply(null, url_parts);
    };

    /**
     * Creates a basic error handler that wraps a jqXHR error as an Error.
     *
     * Takes a callback that accepts an Error, and returns a callback that can
     * be passed directly to $.ajax, which will wrap the error from jQuery
     * as an Error, and pass that to the original callback.
     *
     * @method create_basic_error_handler
     * @param{Function} callback
     * @return{Function}
     */
    Contents.prototype.create_basic_error_handler = function(callback) {
        if (!callback) {
            return utils.log_ajax_error;
        }
        return function(xhr, status, error) {
            callback(utils.wrap_ajax_error(xhr, status, error));
        };
    };

    /**
     * File Functions (including notebook operations)
     */

    /**
     * Get a file.
     *
     * @method get
     * @param {String} path
     * @param {Object} options
     *    type : 'notebook', 'file', or 'directory'
     *    format: 'text' or 'base64'; only relevant for type: 'file'
     *    content: true or false; // whether to include the content
     */
    Contents.prototype.get = function (path, options) {
        /**
         * We do the call with settings so we can set cache to false.
         */
        var settings = {
            processData : false,
            cache : false,
            type : "GET",
            dataType : "json",
        };
        var url = this.api_url(path);
        var params = {};
        if (options.type) { params.type = options.type; }
        if (options.format) { params.format = options.format; }
        if (options.content === false) { params.content = '0'; }
        return utils.promising_ajax(url + '?' + $.param(params), settings);
    };


    /**
     * Creates a new untitled file or directory in the specified directory path.
     *
     * @method new
     * @param {String} path: the directory in which to create the new file/directory
     * @param {Object} options:
     *      ext: file extension to use
     *      type: model type to create ('notebook', 'file', or 'directory')
     */
    Contents.prototype.new_untitled = function(path, options) {
        var data = JSON.stringify({
          ext: options.ext,
          type: options.type
        });

        var settings = {
            processData : false,
            type : "POST",
            data: data,
            contentType: 'application/json',
            dataType : "json",
        };
        return utils.promising_ajax(this.api_url(path), settings);
    };

    Contents.prototype.delete = function(path) {
        var settings = {
            processData : false,
            type : "DELETE",
            dataType : "json",
        };
        var url = this.api_url(path);
        return utils.promising_ajax(url, settings).catch(
            // Translate certain errors to more specific ones.
            function(error) {
                // TODO: update IPEP27 to specify errors more precisely, so
                // that error types can be detected here with certainty.
                if (error.xhr.status === 400) {
                    throw new Contents.DirectoryNotEmptyError();
                }
                throw error;
            }
        );
    };

    Contents.prototype.copy = function(from_file, to_dir) {
        /**
         * Copy a file into a given directory via POST
         * The server will select the name of the copied file
         */
        var url = this.api_url(to_dir);

        var settings = {
            processData : false,
            type: "POST",
            data: JSON.stringify({copy_from: from_file}),
            contentType: 'application/json',
            dataType : "json",
        };
        return utils.promising_ajax(url, settings);
    };

    /**
     * Checkpointing Functions
     */

    Contents.prototype.create_checkpoint = function(path) {
        var url = this.api_url(path, 'checkpoints');
        var settings = {
            type : "POST",
            contentType: false,  // no data
            dataType : "json",
        };
        return utils.promising_ajax(url, settings);
    };

    Contents.prototype.restore_checkpoint = function(path, checkpoint_id) {
        var url = this.api_url(path, 'checkpoints', checkpoint_id);
        var settings = {
            type : "POST",
            contentType: false,  // no data
        };
        return utils.promising_ajax(url, settings);
    };

    Contents.prototype.delete_checkpoint = function(path, checkpoint_id) {
        var url = this.api_url(path, 'checkpoints', checkpoint_id);
        var settings = {
            type : "DELETE",
        };
        return utils.promising_ajax(url, settings);
    };

    /**
     * File management functions
     */

    /**
     * List notebooks and directories at a given path
     *
     * On success, load_callback is called with an array of dictionaries
     * representing individual files or directories.  Each dictionary has
     * the keys:
     *     type: "notebook" or "directory"
     *     created: created date
     *     last_modified: last modified dat
     * @method list_notebooks
     * @param {String} path The path to list notebooks in
     */
    Contents.prototype.list_contents = function(path) {
        return this.get(path, {type: 'directory'});
    };

    return {'Contents': Contents};
})();

var notebookJsCell = (function notebookJsCell() {
    "use strict";

    var utils = baseJsUtils;

    var overlayHack = CodeMirror.scrollbarModel.native.prototype.overlayHack;

    CodeMirror.scrollbarModel.native.prototype.overlayHack = function () {
        overlayHack.apply(this, arguments);
        // Reverse `min-height: 18px` scrollbar hack on OS X
        // which causes a dead area, making it impossible to click on the last line
        // when there is horizontal scrolling to do and the "show scrollbar only when scrolling" behavior
        // is enabled.
        // This, in turn, has the undesirable behavior of never showing the horizontal scrollbar,
        // even when it should, which is less problematic, at least.
        if (/Mac/.test(navigator.platform)) {
            this.horiz.style.minHeight = "";
        }
    };

    var Cell = function (options) {
        /* Constructor
         *
         * The Base `Cell` class from which to inherit.
         * @constructor
         * @param:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          config: dictionary
         *          keyboard_manager: KeyboardManager instance
         */
        options = options || {};
        this.keyboard_manager = options.keyboard_manager;
        this.events = options.events;
        var config = utils.mergeopt(Cell, options.config);
        // superclass default overwrite our default

        this.placeholder = config.placeholder || '';
        this.selected = false;
        this.rendered = false;
        this.mode = 'command';

        // Metadata property
        var that = this;
        this._metadata = {};
        Object.defineProperty(this, 'metadata', {
            get: function() { return that._metadata; },
            set: function(value) {
                that._metadata = value;
                if (that.celltoolbar) {
                    that.celltoolbar.rebuild();
                }
            }
        });

        // backward compat.
        Object.defineProperty(this, 'cm_config', {
            get: function() {
                console.warn("Warning: accessing Cell.cm_config directly is deprecate.")
                return that._options.cm_config;
            },
        });

        // load this from metadata later ?
        this.user_highlight = 'auto';


        var _local_cm_config = {};
        if(this.class_config){
            _local_cm_config = {
                extraKeys: {
                    "Tab" :  "indentMore",
                    "Shift-Tab" : "indentLess",
                    "Backspace" : "delSpaceToPrevTabStop",
                    "Cmd-/" : "toggleComment",
                    "Ctrl-/" : "toggleComment"
                },
                mode: 'text',
                theme: 'ipython',
                matchBrackets: true,
                autoCloseBrackets: true
            };
               // this.class_config.get_sync('cm_config');
        }
        config.cm_config = utils.mergeopt({}, config.cm_config, _local_cm_config);
        this.cell_id = utils.uuid();
        this._options = config;

        // For JS VM engines optimization, attributes should be all set (even
        // to null) in the constructor, and if possible, if different subclass
        // have new attributes with same name, they should be created in the
        // same order. Easiest is to create and set to null in parent class.

        this.element = null;
        this.cell_type = this.cell_type || null;
        this.code_mirror = null;

        this.create_element();
        if (this.element !== null) {
            this.element.data("cell", this);
            this.bind_events();
            this.init_classes();
        }
    };

    Cell.options_default = {
        cm_config : {
            indentUnit : 4,
            theme: "default",
            readOnly: 'nocursor',
            extraKeys: {
                "Cmd-Right":"goLineRight",
                "End":"goLineRight",
                "Cmd-Left":"goLineLeft"
            }
        }
    };

    // FIXME: Workaround CM Bug #332 (Safari segfault on drag)
    // by disabling drag/drop altogether on Safari
    // https://github.com/codemirror/CodeMirror/issues/332
    if (utils.browser[0] == "Safari") {
        Cell.options_default.cm_config.dragDrop = false;
    }

    /**
     * Empty. Subclasses must implement create_element.
     * This should contain all the code to create the DOM element in notebook
     * and will be called by Base Class constructor.
     * @method create_element
     */
    Cell.prototype.create_element = function () {
    };

    Cell.prototype.init_classes = function () {
        /**
         * Call after this.element exists to initialize the css classes
         * related to selected, rendered and mode.
         */
        if (this.selected) {
            this.element.addClass('selected');
        } else {
            this.element.addClass('unselected');
        }
        if (this.rendered) {
            this.element.addClass('rendered');
        } else {
            this.element.addClass('unrendered');
        }
    };

    /**
     * Subclasses can implement override bind_events.
     * Be carefull to call the parent method when overwriting as it fires event.
     * this will be triggerd after create_element in constructor.
     * @method bind_events
     */
    Cell.prototype.bind_events = function () {
        var that = this;
        // We trigger events so that Cell doesn't have to depend on Notebook.
        that.element.click(function (event) {
            if (!that.selected) {
                that.events.trigger('select.Cell', {'cell':that});
            }
        });
        that.element.focusin(function (event) {
            if (!that.selected) {
                that.events.trigger('select.Cell', {'cell':that});
            }
        });
        if (this.code_mirror) {
            this.code_mirror.on("change", function(cm, change) {
                that.events.trigger("set_dirty.Notebook", {value: true});
            });
        }
        if (this.code_mirror) {
            this.code_mirror.on('focus', function(cm, change) {
                that.events.trigger('edit_mode.Cell', {cell: that});
            });
        }
        if (this.code_mirror) {
            this.code_mirror.on('blur', function(cm, change) {
                that.events.trigger('command_mode.Cell', {cell: that});
            });
        }
    };

    /**
     * This method gets called in CodeMirror's onKeyDown/onKeyPress
     * handlers and is used to provide custom key handling.
     *
     * To have custom handling, subclasses should override this method, but still call it
     * in order to process the Edit mode keyboard shortcuts.
     *
     * @method handle_codemirror_keyevent
     * @param {CodeMirror} editor - The codemirror instance bound to the cell
     * @param {event} event - key press event which either should or should not be handled by CodeMirror
     * @return {Boolean} `true` if CodeMirror should ignore the event, `false` Otherwise
     */
    Cell.prototype.handle_codemirror_keyevent = function (editor, event) {
        var shortcuts = this.keyboard_manager.edit_shortcuts;

        var cur = editor.getCursor();
        if((cur.line !== 0 || cur.ch !==0) && event.keyCode === 38){
            event._ipkmIgnore = true;
        }
        var nLastLine = editor.lastLine();
        if ((event.keyCode === 40) &&
             ((cur.line !== nLastLine) ||
               (cur.ch !== editor.getLineHandle(nLastLine).text.length))
           ) {
            event._ipkmIgnore = true;
        }
        // if this is an edit_shortcuts shortcut, the global keyboard/shortcut
        // manager will handle it
        if (shortcuts.handles(event)) {
            return true;
        }

        return false;
    };


    /**
     * Triger typsetting of math by mathjax on current cell element
     * @method typeset
     */
    Cell.prototype.typeset = function () {
        utils.typeset(this.element);
    };

    /**
     * handle cell level logic when a cell is selected
     * @method select
     * @return is the action being taken
     */
    Cell.prototype.select = function () {
        if (!this.selected) {
            this.element.addClass('selected');
            this.element.removeClass('unselected');
            this.selected = true;
            return true;
        } else {
            return false;
        }
    };

    /**
     * handle cell level logic when a cell is unselected
     * @method unselect
     * @return is the action being taken
     */
    Cell.prototype.unselect = function () {
        if (this.selected) {
            this.element.addClass('unselected');
            this.element.removeClass('selected');
            this.selected = false;
            return true;
        } else {
            return false;
        }
    };

    /**
     * should be overritten by subclass
     * @method execute
     */
    Cell.prototype.execute = function () {
        return;
    };

    /**
     * handle cell level logic when a cell is rendered
     * @method render
     * @return is the action being taken
     */
    Cell.prototype.render = function () {
        if (!this.rendered) {
            this.element.addClass('rendered');
            this.element.removeClass('unrendered');
            this.rendered = true;
            return true;
        } else {
            return false;
        }
    };

    /**
     * handle cell level logic when a cell is unrendered
     * @method unrender
     * @return is the action being taken
     */
    Cell.prototype.unrender = function () {
        if (this.rendered) {
            this.element.addClass('unrendered');
            this.element.removeClass('rendered');
            this.rendered = false;
            return true;
        } else {
            return false;
        }
    };

    /**
     * Delegates keyboard shortcut handling to either Jupyter keyboard
     * manager when in command mode, or CodeMirror when in edit mode
     *
     * @method handle_keyevent
     * @param {CodeMirror} editor - The codemirror instance bound to the cell
     * @param {event} - key event to be handled
     * @return {Boolean} `true` if CodeMirror should ignore the event, `false` Otherwise
     */
    Cell.prototype.handle_keyevent = function (editor, event) {
        if (this.mode === 'command') {
            return true;
        } else if (this.mode === 'edit') {
            return this.handle_codemirror_keyevent(editor, event);
        }
    };

    /**
     * @method at_top
     * @return {Boolean}
     */
    Cell.prototype.at_top = function () {
        var cm = this.code_mirror;
        var cursor = cm.getCursor();
        if (cursor.line === 0 && cursor.ch === 0) {
            return true;
        }
        return false;
    };

    /**
     * @method at_bottom
     * @return {Boolean}
     * */
    Cell.prototype.at_bottom = function () {
        var cm = this.code_mirror;
        var cursor = cm.getCursor();
        if (cursor.line === (cm.lineCount()-1) && cursor.ch === cm.getLine(cursor.line).length) {
            return true;
        }
        return false;
    };

    /**
     * enter the command mode for the cell
     * @method command_mode
     * @return is the action being taken
     */
    Cell.prototype.command_mode = function () {
        if (this.mode !== 'command') {
            this.mode = 'command';
            return true;
        } else {
            return false;
        }
    };

    /**
     * enter the edit mode for the cell
     * @method command_mode
     * @return is the action being taken
     */
    Cell.prototype.edit_mode = function () {
        if (this.mode !== 'edit') {
            this.mode = 'edit';
            return true;
        } else {
            return false;
        }
    };

    Cell.prototype.ensure_focused = function() {
        if(this.element !== document.activeElement && !this.code_mirror.hasFocus()){
            this.focus_cell();
        }
    }

    /**
     * Focus the cell in the DOM sense
     * @method focus_cell
     */
    Cell.prototype.focus_cell = function () {
        this.element.focus();
    };

    /**
     * Focus the editor area so a user can type
     *
     * NOTE: If codemirror is focused via a mouse click event, you don't want to
     * call this because it will cause a page jump.
     * @method focus_editor
     */
    Cell.prototype.focus_editor = function () {
        this.refresh();
        this.code_mirror.focus();
    };

    /**
     * Refresh codemirror instance
     * @method refresh
     */
    Cell.prototype.refresh = function () {
        if (this.code_mirror) {
            this.code_mirror.refresh();
        }
    };

    /**
     * should be overritten by subclass
     * @method get_text
     */
    Cell.prototype.get_text = function () {
    };

    /**
     * should be overritten by subclass
     * @method set_text
     * @param {string} text
     */
    Cell.prototype.set_text = function (text) {
    };

    /**
     * should be overritten by subclass
     * serialise cell to json.
     * @method toJSON
     **/
    Cell.prototype.toJSON = function () {
        var data = {};
        // deepcopy the metadata so copied cells don't share the same object
        data.metadata = JSON.parse(JSON.stringify(this.metadata));
        data.cell_type = this.cell_type;
        return data;
    };

    /**
     * should be overritten by subclass
     * @method fromJSON
     **/
    Cell.prototype.fromJSON = function (data) {
        if (data.metadata !== undefined) {
            this.metadata = data.metadata;
        }
    };


    /**
     * can the cell be split into two cells (false if not deletable)
     * @method is_splittable
     **/
    Cell.prototype.is_splittable = function () {
        return this.is_deletable();
    };


    /**
     * can the cell be merged with other cells (false if not deletable)
     * @method is_mergeable
     **/
    Cell.prototype.is_mergeable = function () {
        return this.is_deletable();
    };

    /**
     * is the cell deletable? only false (undeletable) if
     * metadata.deletable is explicitly false -- everything else
     * counts as true
     *
     * @method is_deletable
     **/
    Cell.prototype.is_deletable = function () {
        if (this.metadata.deletable === false) {
            return false;
        }
        return true;
    };

    /**
     * @return {String} - the text before the cursor
     * @method get_pre_cursor
     **/
    Cell.prototype.get_pre_cursor = function () {
        var cursor = this.code_mirror.getCursor();
        var text = this.code_mirror.getRange({line:0, ch:0}, cursor);
        text = text.replace(/^\n+/, '').replace(/\n+$/, '');
        return text;
    };


    /**
     * @return {String} - the text after the cursor
     * @method get_post_cursor
     **/
    Cell.prototype.get_post_cursor = function () {
        var cursor = this.code_mirror.getCursor();
        var last_line_num = this.code_mirror.lineCount()-1;
        var last_line_len = this.code_mirror.getLine(last_line_num).length;
        var end = {line:last_line_num, ch:last_line_len};
        var text = this.code_mirror.getRange(cursor, end);
        text = text.replace(/^\n+/, '').replace(/\n+$/, '');
        return text;
    };

    /**
     * Show/Hide CodeMirror LineNumber
     * @method show_line_numbers
     *
     * @param value {Bool}  show (true), or hide (false) the line number in CodeMirror
     **/
    Cell.prototype.show_line_numbers = function (value) {
        this.code_mirror.setOption('lineNumbers', value);
        this.code_mirror.refresh();
    };

    /**
     * Toggle  CodeMirror LineNumber
     * @method toggle_line_numbers
     **/
    Cell.prototype.toggle_line_numbers = function () {
        var val = this.code_mirror.getOption('lineNumbers');
        this.show_line_numbers(!val);
    };

    /**
     * Force codemirror highlight mode
     * @method force_highlight
     * @param {object} - CodeMirror mode
     **/
    Cell.prototype.force_highlight = function(mode) {
        this.user_highlight = mode;
        this.auto_highlight();
    };

    /**
     * Trigger autodetection of highlight scheme for current cell
     * @method auto_highlight
     */
    Cell.prototype.auto_highlight = function () {
        //this._auto_highlight(this.class_config.get_sync('highlight_modes'));
        this._auto_highlight({
            'magic_javascript'    :{'reg':['^%%javascript']},
            'magic_perl'          :{'reg':['^%%perl']},
            'magic_ruby'          :{'reg':['^%%ruby']},
            'magic_python'        :{'reg':['^%%python3?']},
            'magic_shell'         :{'reg':['^%%bash']},
            'magic_r'             :{'reg':['^%%R']},
            'magic_text/x-cython' :{'reg':['^%%cython']},
        });
    };

    /**
     * Try to autodetect cell highlight mode, or use selected mode
     * @methods _auto_highlight
     * @private
     * @param {String|object|undefined} - CodeMirror mode | 'auto'
     **/
    Cell.prototype._auto_highlight = function (modes) {
        /**
         *Here we handle manually selected modes
         */
        var that = this;
        var mode;
        if( this.user_highlight !== undefined &&  this.user_highlight != 'auto' )
        {
            mode = this.user_highlight;
            CodeMirror.autoLoadMode(this.code_mirror, mode);
            this.code_mirror.setOption('mode', mode);
            return;
        }
        var current_mode = this.code_mirror.getOption('mode', mode);
        var first_line = this.code_mirror.getLine(0);
        // loop on every pairs
        for(mode in modes) {
            var regs = modes[mode].reg;
            // only one key every time but regexp can't be keys...
            for(var i=0; i<regs.length; i++) {
                // here we handle non magic_modes.
                // TODO :
                // On 3.0 and below, these things were regex.
                // But now should be string for json-able config.
                // We should get rid of assuming they might be already
                // in a later version of Jupyter.
                var re = regs[i];
                if(typeof(re) === 'string'){
                    re = new RegExp(re)
                }
                if(first_line.match(re) !== null) {
                    if(current_mode == mode){
                        return;
                    }
                    if (mode.search('magic_') !== 0) {
                        utils.requireCodeMirrorMode(mode, function (spec) {
                            that.code_mirror.setOption('mode', spec);
                        });
                        return;
                    }
                    var open = modes[mode].open || "%%";
                    var close = modes[mode].close || "%%end";
                    var magic_mode = mode;
                    mode = magic_mode.substr(6);
                    if(current_mode == magic_mode){
                        return;
                    }
                    utils.requireCodeMirrorMode(mode, function (spec) {
                        // create on the fly a mode that switch between
                        // plain/text and something else, otherwise `%%` is
                        // source of some highlight issues.
                        CodeMirror.defineMode(magic_mode, function(config) {
                            return CodeMirror.multiplexingMode(
                                CodeMirror.getMode(config, 'text/plain'),
                                // always set something on close
                                {open: open, close: close,
                                 mode: CodeMirror.getMode(config, spec),
                                 delimStyle: "delimit"
                                }
                            );
                        });
                        that.code_mirror.setOption('mode', magic_mode);
                    });
                    return;
                }
            }
        }
        // fallback on default
        var default_mode;
        try {
            default_mode = this._options.cm_config.mode;
        } catch(e) {
            default_mode = 'text/plain';
        }
        if( current_mode === default_mode){
            return;
        }
        this.code_mirror.setOption('mode', default_mode);
    };

    var UnrecognizedCell = function (options) {
        /** Constructor for unrecognized cells */
        Cell.apply(this, arguments);
        this.cell_type = 'unrecognized';
        this.celltoolbar = null;
        this.data = {};

        Object.seal(this);
    };

    UnrecognizedCell.prototype = Object.create(Cell.prototype);


    // cannot merge or split unrecognized cells
    UnrecognizedCell.prototype.is_mergeable = function () {
        return false;
    };

    UnrecognizedCell.prototype.is_splittable = function () {
        return false;
    };

    UnrecognizedCell.prototype.toJSON = function () {
        /**
         * deepcopy the metadata so copied cells don't share the same object
         */
        return JSON.parse(JSON.stringify(this.data));
    };

    UnrecognizedCell.prototype.fromJSON = function (data) {
        this.data = data;
        if (data.metadata !== undefined) {
            this.metadata = data.metadata;
        } else {
            data.metadata = this.metadata;
        }
        this.element.find('.inner_cell').find("a").text("Unrecognized cell type: " + data.cell_type);
    };

    UnrecognizedCell.prototype.create_element = function () {
        Cell.prototype.create_element.apply(this, arguments);
        var cell = this.element = $("<div>").addClass('cell unrecognized_cell');
        cell.attr('tabindex','2');

        var prompt = $('<div/>').addClass('prompt input_prompt');
        cell.append(prompt);
        var inner_cell = $('<div/>').addClass('inner_cell');
        inner_cell.append(
            $("<a>")
                .attr("href", "#")
                .text("Unrecognized cell type")
        );
        cell.append(inner_cell);
        this.element = cell;
    };

    UnrecognizedCell.prototype.bind_events = function () {
        Cell.prototype.bind_events.apply(this, arguments);
        var cell = this;

        this.element.find('.inner_cell').find("a").click(function () {
            cell.events.trigger('unrecognized_cell.Cell', {cell: cell});
        });
    };

    return {
        Cell: Cell,
        UnrecognizedCell: UnrecognizedCell
    };
})();

var CSS_PROP_BIT_QUANTITY=1;var CSS_PROP_BIT_HASH_VALUE=2;var CSS_PROP_BIT_NEGATIVE_QUANTITY=4;var CSS_PROP_BIT_QSTRING=8;var CSS_PROP_BIT_URL=16;var CSS_PROP_BIT_UNRESERVED_WORD=64;var CSS_PROP_BIT_UNICODE_RANGE=128;var CSS_PROP_BIT_GLOBAL_NAME=512;var CSS_PROP_BIT_PROPERTY_NAME=1024;var cssSchema=function(){var L=[["aliceblue","antiquewhite","aqua","aquamarine","azure","beige","bisque","black","blanchedalmond","blue","blueviolet","brown","burlywood","cadetblue","chartreuse","chocolate","coral","cornflowerblue","cornsilk","crimson","cyan","darkblue","darkcyan","darkgoldenrod","darkgray","darkgreen","darkkhaki","darkmagenta","darkolivegreen","darkorange","darkorchid","darkred","darksalmon","darkseagreen","darkslateblue","darkslategray","darkturquoise","darkviolet","deeppink","deepskyblue","dimgray","dodgerblue","firebrick","floralwhite","forestgreen","fuchsia","gainsboro","ghostwhite","gold","goldenrod","gray","green","greenyellow","honeydew","hotpink","indianred","indigo","ivory","khaki","lavender","lavenderblush","lawngreen","lemonchiffon","lightblue","lightcoral","lightcyan","lightgoldenrodyellow","lightgreen","lightgrey","lightpink","lightsalmon","lightseagreen","lightskyblue","lightslategray","lightsteelblue","lightyellow","lime","limegreen","linen","magenta","maroon","mediumaquamarine","mediumblue","mediumorchid","mediumpurple","mediumseagreen","mediumslateblue","mediumspringgreen","mediumturquoise","mediumvioletred","midnightblue","mintcream","mistyrose","moccasin","navajowhite","navy","oldlace","olive","olivedrab","orange","orangered","orchid","palegoldenrod","palegreen","paleturquoise","palevioletred","papayawhip","peachpuff","peru","pink","plum","powderblue","purple","red","rosybrown","royalblue","saddlebrown","salmon","sandybrown","seagreen","seashell","sienna","silver","skyblue","slateblue","slategray","snow","springgreen","steelblue","tan","teal","thistle","tomato","transparent","turquoise","violet","wheat","white","whitesmoke","yellow","yellowgreen"],["all-scroll","col-resize","crosshair","default","e-resize","hand","help","move","n-resize","ne-resize","no-drop","not-allowed","nw-resize","pointer","progress","row-resize","s-resize","se-resize","sw-resize","text","vertical-text","w-resize","wait"],["armenian","decimal","decimal-leading-zero","disc","georgian","lower-alpha","lower-greek","lower-latin","lower-roman","square","upper-alpha","upper-latin","upper-roman"],["100","200","300","400","500","600","700","800","900","bold","bolder","lighter"],["block-level","inline-level","table-caption","table-cell","table-column","table-column-group","table-footer-group","table-header-group","table-row","table-row-group"],["condensed","expanded","extra-condensed","extra-expanded","narrower","semi-condensed","semi-expanded","ultra-condensed","ultra-expanded","wider"],["inherit","inline","inline-block","inline-box","inline-flex","inline-grid","inline-list-item","inline-stack","inline-table","run-in"],["behind","center-left","center-right","far-left","far-right","left-side","leftwards","right-side","rightwards"],["large","larger","small","smaller","x-large","x-small","xx-large","xx-small"],["dashed","dotted","double","groove","outset","ridge","solid"],["ease","ease-in","ease-in-out","ease-out","linear","step-end","step-start"],["at","closest-corner","closest-side","ellipse","farthest-corner","farthest-side"],["baseline","middle","sub","super","text-bottom","text-top"],["caption","icon","menu","message-box","small-caption","status-bar"],["fast","faster","slow","slower","x-fast","x-slow"],["above","below","higher","level","lower"],["cursive","fantasy","monospace","sans-serif","serif"],["loud","silent","soft","x-loud","x-soft"],["no-repeat","repeat-x","repeat-y","round","space"],["blink","line-through","overline","underline"],["block","flex","grid","table"],["high","low","x-high","x-low"],["nowrap","pre","pre-line","pre-wrap"],["absolute","relative","static"],["alternate","alternate-reverse","reverse"],["border-box","content-box","padding-box"],["capitalize","lowercase","uppercase"],["child","female","male"],["=","opacity"],["backwards","forwards"],["bidi-override","embed"],["bottom","top"],["break-all","keep-all"],["clip","ellipsis"],["contain","cover"],["continuous","digits"],["end","start"],["flat","preserve-3d"],["hide","show"],["horizontal","vertical"],["inside","outside"],["italic","oblique"],["left","right"],["ltr","rtl"],["no-content","no-display"],["paused","running"],["suppress","unrestricted"],["thick","thin"],[","],["/"],["all"],["always"],["auto"],["avoid"],["both"],["break-word"],["center"],["circle"],["code"],["collapse"],["contents"],["fixed"],["hidden"],["infinite"],["inset"],["invert"],["justify"],["list-item"],["local"],["medium"],["mix"],["none"],["normal"],["once"],["repeat"],["scroll"],["separate"],["small-caps"],["spell-out"],["to"],["visible"]];var schema={animation:{cssPropBits:517,cssLitGroup:[L[10],L[24],L[29],L[45],L[48],L[54],L[63],L[71],L[72]],cssFns:["cubic-bezier()","steps()"]},"animation-delay":{cssPropBits:5,cssLitGroup:[L[48]],cssFns:[]},"animation-direction":{cssPropBits:0,cssLitGroup:[L[24],L[48],L[72]],cssFns:[]},"animation-duration":"animation-delay","animation-fill-mode":{cssPropBits:0,cssLitGroup:[L[29],L[48],L[54],L[71]],cssFns:[]},"animation-iteration-count":{cssPropBits:5,cssLitGroup:[L[48],L[63]],cssFns:[]},"animation-name":{cssPropBits:512,cssLitGroup:[L[48],L[71]],cssFns:[]},"animation-play-state":{cssPropBits:0,cssLitGroup:[L[45],L[48]],cssFns:[]},"animation-timing-function":{cssPropBits:0,cssLitGroup:[L[10],L[48]],cssFns:["cubic-bezier()","steps()"]},appearance:{cssPropBits:0,cssLitGroup:[L[71]],cssFns:[]},azimuth:{cssPropBits:5,cssLitGroup:[L[7],L[42],L[56]],cssFns:[]},"backface-visibility":{cssPropBits:0,cssLitGroup:[L[59],L[62],L[80]],cssFns:[]},background:{cssPropBits:23,cssLitGroup:[L[0],L[18],L[25],L[31],L[34],L[42],L[48],L[49],L[52],L[56],L[61],L[68],L[71],L[74],L[75]],cssFns:["image()","linear-gradient()","radial-gradient()","repeating-linear-gradient()","repeating-radial-gradient()","rgb()","rgba()"]},"background-attachment":{cssPropBits:0,cssLitGroup:[L[48],L[61],L[68],L[75]],cssFns:[]},"background-color":{cssPropBits:2,cssLitGroup:[L[0]],cssFns:["rgb()","rgba()"]},"background-image":{cssPropBits:16,cssLitGroup:[L[48],L[71]],cssFns:["image()","linear-gradient()","radial-gradient()","repeating-linear-gradient()","repeating-radial-gradient()"]},"background-position":{cssPropBits:5,cssLitGroup:[L[31],L[42],L[48],L[56]],cssFns:[]},"background-repeat":{cssPropBits:0,cssLitGroup:[L[18],L[48],L[74]],cssFns:[]},"background-size":{cssPropBits:5,cssLitGroup:[L[34],L[48],L[52]],cssFns:[]},border:{cssPropBits:7,cssLitGroup:[L[0],L[9],L[47],L[62],L[64],L[69],L[71]],cssFns:["rgb()","rgba()"]},"border-bottom":"border","border-bottom-color":"background-color","border-bottom-left-radius":{cssPropBits:5,cssFns:[]},"border-bottom-right-radius":"border-bottom-left-radius","border-bottom-style":{cssPropBits:0,cssLitGroup:[L[9],L[62],L[64],L[71]],cssFns:[]},"border-bottom-width":{cssPropBits:5,cssLitGroup:[L[47],L[69]],cssFns:[]},"border-collapse":{cssPropBits:0,cssLitGroup:[L[59],L[76]],cssFns:[]},"border-color":"background-color","border-left":"border","border-left-color":"background-color","border-left-style":"border-bottom-style","border-left-width":"border-bottom-width","border-radius":{cssPropBits:5,cssLitGroup:[L[49]],cssFns:[]},"border-right":"border","border-right-color":"background-color","border-right-style":"border-bottom-style","border-right-width":"border-bottom-width","border-spacing":"border-bottom-left-radius","border-style":"border-bottom-style","border-top":"border","border-top-color":"background-color","border-top-left-radius":"border-bottom-left-radius","border-top-right-radius":"border-bottom-left-radius","border-top-style":"border-bottom-style","border-top-width":"border-bottom-width","border-width":"border-bottom-width",bottom:{cssPropBits:5,cssLitGroup:[L[52]],cssFns:[]},box:{cssPropBits:0,cssLitGroup:[L[60],L[71],L[72]],cssFns:[]},"box-shadow":{cssPropBits:7,cssLitGroup:[L[0],L[48],L[64],L[71]],cssFns:["rgb()","rgba()"]},"box-sizing":{cssPropBits:0,cssLitGroup:[L[25]],cssFns:[]},"caption-side":{cssPropBits:0,cssLitGroup:[L[31]],cssFns:[]},clear:{cssPropBits:0,cssLitGroup:[L[42],L[54],L[71]],cssFns:[]},clip:{cssPropBits:0,cssLitGroup:[L[52]],cssFns:["rect()"]},color:"background-color",content:{cssPropBits:8,cssLitGroup:[L[71],L[72]],cssFns:[]},cue:{cssPropBits:16,cssLitGroup:[L[71]],cssFns:[]},"cue-after":"cue","cue-before":"cue",cursor:{cssPropBits:16,cssLitGroup:[L[1],L[48],L[52]],cssFns:[]},direction:{cssPropBits:0,cssLitGroup:[L[43]],cssFns:[]},display:{cssPropBits:0,cssLitGroup:[L[4],L[6],L[20],L[52],L[67],L[71]],cssFns:[]},"display-extras":{cssPropBits:0,cssLitGroup:[L[67],L[71]],cssFns:[]},"display-inside":{cssPropBits:0,cssLitGroup:[L[20],L[52]],cssFns:[]},"display-outside":{cssPropBits:0,cssLitGroup:[L[4],L[71]],cssFns:[]},elevation:{cssPropBits:5,cssLitGroup:[L[15]],cssFns:[]},"empty-cells":{cssPropBits:0,cssLitGroup:[L[38]],cssFns:[]},filter:{cssPropBits:0,cssFns:["alpha()"]},"float":{cssPropBits:0,cssLitGroup:[L[42],L[71]],cssFns:[]},font:{cssPropBits:73,cssLitGroup:[L[3],L[8],L[13],L[16],L[41],L[48],L[49],L[69],L[72],L[77]],cssFns:[]},"font-family":{cssPropBits:72,cssLitGroup:[L[16],L[48]],cssFns:[]},"font-size":{cssPropBits:1,cssLitGroup:[L[8],L[69]],cssFns:[]},"font-stretch":{cssPropBits:0,cssLitGroup:[L[5],L[72]],cssFns:[]},"font-style":{cssPropBits:0,cssLitGroup:[L[41],L[72]],cssFns:[]},"font-variant":{cssPropBits:0,cssLitGroup:[L[72],L[77]],cssFns:[]},"font-weight":{cssPropBits:0,cssLitGroup:[L[3],L[72]],cssFns:[]},height:"bottom",left:"bottom","letter-spacing":{cssPropBits:5,cssLitGroup:[L[72]],cssFns:[]},"line-height":{cssPropBits:1,cssLitGroup:[L[72]],cssFns:[]},"list-style":{cssPropBits:16,cssLitGroup:[L[2],L[40],L[57],L[71]],cssFns:["image()","linear-gradient()","radial-gradient()","repeating-linear-gradient()","repeating-radial-gradient()"]},"list-style-image":{cssPropBits:16,cssLitGroup:[L[71]],cssFns:["image()","linear-gradient()","radial-gradient()","repeating-linear-gradient()","repeating-radial-gradient()"]},"list-style-position":{cssPropBits:0,cssLitGroup:[L[40]],cssFns:[]},"list-style-type":{cssPropBits:0,cssLitGroup:[L[2],L[57],L[71]],cssFns:[]},margin:"bottom","margin-bottom":"bottom","margin-left":"bottom","margin-right":"bottom","margin-top":"bottom","max-height":{cssPropBits:1,cssLitGroup:[L[52],L[71]],cssFns:[]},"max-width":"max-height","min-height":{cssPropBits:1,cssLitGroup:[L[52]],cssFns:[]},"min-width":"min-height",opacity:{cssPropBits:1,cssFns:[]},outline:{cssPropBits:7,cssLitGroup:[L[0],L[9],L[47],L[62],L[64],L[65],L[69],L[71]],cssFns:["rgb()","rgba()"]},"outline-color":{cssPropBits:2,cssLitGroup:[L[0],L[65]],cssFns:["rgb()","rgba()"]},"outline-style":"border-bottom-style","outline-width":"border-bottom-width",overflow:{cssPropBits:0,cssLitGroup:[L[52],L[62],L[75],L[80]],cssFns:[]},"overflow-wrap":{cssPropBits:0,cssLitGroup:[L[55],L[72]],cssFns:[]},"overflow-x":{cssPropBits:0,cssLitGroup:[L[44],L[52],L[62],L[75],L[80]],cssFns:[]},"overflow-y":"overflow-x",padding:"opacity","padding-bottom":"opacity","padding-left":"opacity","padding-right":"opacity","padding-top":"opacity","page-break-after":{cssPropBits:0,cssLitGroup:[L[42],L[51],L[52],L[53]],cssFns:[]},"page-break-before":"page-break-after","page-break-inside":{cssPropBits:0,cssLitGroup:[L[52],L[53]],cssFns:[]},pause:"border-bottom-left-radius","pause-after":"border-bottom-left-radius","pause-before":"border-bottom-left-radius",perspective:{cssPropBits:5,cssLitGroup:[L[71]],cssFns:[]},"perspective-origin":{cssPropBits:5,cssLitGroup:[L[31],L[42],L[56]],cssFns:[]},pitch:{cssPropBits:5,cssLitGroup:[L[21],L[69]],cssFns:[]},"pitch-range":"border-bottom-left-radius","play-during":{cssPropBits:16,cssLitGroup:[L[52],L[70],L[71],L[74]],cssFns:[]},position:{cssPropBits:0,cssLitGroup:[L[23]],cssFns:[]},quotes:{cssPropBits:8,cssLitGroup:[L[71]],cssFns:[]},resize:{cssPropBits:0,cssLitGroup:[L[39],L[54],L[71]],cssFns:[]},richness:"border-bottom-left-radius",right:"bottom",speak:{cssPropBits:0,cssLitGroup:[L[71],L[72],L[78]],cssFns:[]},"speak-header":{cssPropBits:0,cssLitGroup:[L[51],L[73]],cssFns:[]},"speak-numeral":{cssPropBits:0,cssLitGroup:[L[35]],cssFns:[]},"speak-punctuation":{cssPropBits:0,cssLitGroup:[L[58],L[71]],cssFns:[]},"speech-rate":{cssPropBits:5,cssLitGroup:[L[14],L[69]],cssFns:[]},stress:"border-bottom-left-radius","table-layout":{cssPropBits:0,cssLitGroup:[L[52],L[61]],cssFns:[]},"text-align":{cssPropBits:0,cssLitGroup:[L[42],L[56],L[66]],cssFns:[]},"text-decoration":{cssPropBits:0,cssLitGroup:[L[19],L[71]],cssFns:[]},"text-indent":"border-bottom-left-radius","text-overflow":{cssPropBits:8,cssLitGroup:[L[33]],cssFns:[]},"text-shadow":"box-shadow","text-transform":{cssPropBits:0,cssLitGroup:[L[26],L[71]],cssFns:[]},"text-wrap":{cssPropBits:0,cssLitGroup:[L[46],L[71],L[72]],cssFns:[]},top:"bottom",transform:{cssPropBits:0,cssLitGroup:[L[71]],cssFns:["matrix()","perspective()","rotate()","rotate3d()","rotatex()","rotatey()","rotatez()","scale()","scale3d()","scalex()","scaley()","scalez()","skew()","skewx()","skewy()","translate()","translate3d()","translatex()","translatey()","translatez()"]},"transform-origin":"perspective-origin","transform-style":{cssPropBits:0,cssLitGroup:[L[37]],cssFns:[]},transition:{cssPropBits:1029,cssLitGroup:[L[10],L[48],L[50],L[71]],cssFns:["cubic-bezier()","steps()"]},"transition-delay":"animation-delay","transition-duration":"animation-delay","transition-property":{cssPropBits:1024,cssLitGroup:[L[48],L[50]],cssFns:[]},"transition-timing-function":"animation-timing-function","unicode-bidi":{cssPropBits:0,cssLitGroup:[L[30],L[72]],cssFns:[]},"vertical-align":{cssPropBits:5,cssLitGroup:[L[12],L[31]],cssFns:[]},visibility:"backface-visibility","voice-family":{cssPropBits:8,cssLitGroup:[L[27],L[48]],cssFns:[]},volume:{cssPropBits:1,cssLitGroup:[L[17],L[69]],cssFns:[]},"white-space":{cssPropBits:0,cssLitGroup:[L[22],L[72]],cssFns:[]},width:"min-height","word-break":{cssPropBits:0,cssLitGroup:[L[32],L[72]],cssFns:[]},"word-spacing":"letter-spacing","word-wrap":"overflow-wrap","z-index":"bottom",zoom:"line-height","cubic-bezier()":"animation-delay","steps()":{cssPropBits:5,cssLitGroup:[L[36],L[48]],cssFns:[]},"image()":{cssPropBits:18,cssLitGroup:[L[0],L[48]],cssFns:["rgb()","rgba()"]},"linear-gradient()":{cssPropBits:7,cssLitGroup:[L[0],L[31],L[42],L[48],L[79]],cssFns:["rgb()","rgba()"]},"radial-gradient()":{cssPropBits:7,cssLitGroup:[L[0],L[11],L[31],L[42],L[48],L[56],L[57]],cssFns:["rgb()","rgba()"]},"repeating-linear-gradient()":"linear-gradient()","repeating-radial-gradient()":"radial-gradient()","rgb()":{cssPropBits:1,cssLitGroup:[L[48]],cssFns:[]},"rgba()":"rgb()","rect()":{cssPropBits:5,cssLitGroup:[L[48],L[52]],cssFns:[]},"alpha()":{cssPropBits:1,cssLitGroup:[L[28]],cssFns:[]},"matrix()":"animation-delay","perspective()":"border-bottom-left-radius","rotate()":"border-bottom-left-radius","rotate3d()":"animation-delay","rotatex()":"border-bottom-left-radius","rotatey()":"border-bottom-left-radius","rotatez()":"border-bottom-left-radius","scale()":"animation-delay","scale3d()":"animation-delay","scalex()":"border-bottom-left-radius","scaley()":"border-bottom-left-radius","scalez()":"border-bottom-left-radius","skew()":"animation-delay","skewx()":"border-bottom-left-radius","skewy()":"border-bottom-left-radius","translate()":"animation-delay","translate3d()":"animation-delay","translatex()":"border-bottom-left-radius","translatey()":"border-bottom-left-radius","translatez()":"border-bottom-left-radius"};if(true){for(var key in schema){if("string"===typeof schema[key]&&Object.hasOwnProperty.call(schema,key)){schema[key]=schema[schema[key]]}}}return schema}();if(typeof window!=="undefined"){window["cssSchema"]=cssSchema}var lexCss;var decodeCss;(function(){function decodeCssEscape(s){var i=parseInt(s.substring(1),16);if(i>65535){return i-=65536,String.fromCharCode(55296+(i>>10),56320+(i&1023))}else if(i==i){return String.fromCharCode(i)}else if(s[1]<" "){return""}else{return s[1]}}function escapeCssString(s,replacer){return'"'+s.replace(/[\u0000-\u001f\\\"<>]/g,replacer)+'"'}function escapeCssStrChar(ch){return cssStrChars[ch]||(cssStrChars[ch]="\\"+ch.charCodeAt(0).toString(16)+" ")}function escapeCssUrlChar(ch){return cssUrlChars[ch]||(cssUrlChars[ch]=(ch<""?"%0":"%")+ch.charCodeAt(0).toString(16))}var cssStrChars={"\\":"\\\\"};var cssUrlChars={"\\":"%5c"};var WC="[\\t\\n\\f ]";var W=WC+"*";var NL="[\\n\\f]";var SURROGATE_PAIR="[\\ud800-\\udbff][\\udc00-\\udfff]";var NONASCII="[\\u0080-\\ud7ff\\ue000-\\ufffd]|"+SURROGATE_PAIR;var UNICODE_TAIL="[0-9a-fA-F]{1,6}"+WC+"?";var UNICODE="\\\\"+UNICODE_TAIL;var ESCAPE_TAIL="(?:"+UNICODE_TAIL+"|[\\u0020-\\u007e\\u0080-\\ud7ff\\ue000\\ufffd]|"+SURROGATE_PAIR+")";var ESCAPE="\\\\"+ESCAPE_TAIL;var URLCHAR="(?:[\\t\\x21\\x23-\\x26\\x28-\\x5b\\x5d-\\x7e]|"+NONASCII+"|"+ESCAPE+")";var STRINGCHAR="[^'\"\\n\\f\\\\]|\\\\[\\s\\S]";var STRING="\"(?:'|"+STRINGCHAR+')*"'+"|'(?:\"|"+STRINGCHAR+")*'";var NUM="[-+]?(?:[0-9]+(?:[.][0-9]+)?|[.][0-9]+)";var NMSTART="(?:[a-zA-Z_]|"+NONASCII+"|"+ESCAPE+")";var NMCHAR="(?:[a-zA-Z0-9_-]|"+NONASCII+"|"+ESCAPE+")";var NAME=NMCHAR+"+";var IDENT="-?"+NMSTART+NMCHAR+"*";var ATKEYWORD="@"+IDENT;var HASH="#"+NAME;var NUMBER=NUM;var WORD_TERM="(?:@?-?"+NMSTART+"|#)"+NMCHAR+"*";var PERCENTAGE=NUM+"%";var DIMENSION=NUM+IDENT;var NUMERIC_VALUE=NUM+"(?:%|"+IDENT+")?";var URI="url[(]"+W+"(?:"+STRING+"|"+URLCHAR+"*)"+W+"[)]";var UNICODE_RANGE="U[+][0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?";var CDO="<!--";var CDC="-->";var S=WC+"+";var COMMENT="/(?:[*][^*]*[*]+(?:[^/][^*]*[*]+)*/|/[^\\n\\f]*)";var FUNCTION="(?!url[(])"+IDENT+"[(]";var INCLUDES="~=";var DASHMATCH="[|]=";var PREFIXMATCH="[^]=";var SUFFIXMATCH="[$]=";var SUBSTRINGMATCH="[*]=";var CMP_OPS="[~|^$*]=";var CHAR="[^\"'\\\\/]|/(?![/*])";var BOM="\\uFEFF";var CSS_TOKEN=new RegExp([BOM,UNICODE_RANGE,URI,FUNCTION,WORD_TERM,STRING,NUMERIC_VALUE,CDO,CDC,S,COMMENT,CMP_OPS,CHAR].join("|"),"gi");var CSS_DECODER=new RegExp("\\\\(?:"+ESCAPE_TAIL+"|"+NL+")","g");var URL_RE=new RegExp("^url\\("+W+"[\"']?|[\"']?"+W+"\\)$","gi");decodeCss=function(css){return css.replace(CSS_DECODER,decodeCssEscape)};lexCss=function(cssText){cssText=""+cssText;var tokens=cssText.replace(/\r\n?/g,"\n").match(CSS_TOKEN)||[];var j=0;var last=" ";for(var i=0,n=tokens.length;i<n;++i){var tok=decodeCss(tokens[i]);var len=tok.length;var cc=tok.charCodeAt(0);tok=cc=='"'.charCodeAt(0)||cc=="'".charCodeAt(0)?escapeCssString(tok.substring(1,len-1),escapeCssStrChar):cc=="/".charCodeAt(0)&&len>1||tok=="\\"||tok==CDC||tok==CDO||tok=="﻿"||cc<=" ".charCodeAt(0)?" ":/url\(/i.test(tok)?"url("+escapeCssString(tok.replace(URL_RE,""),escapeCssUrlChar)+")":tok;if(last!=tok||tok!=" "){tokens[j++]=last=tok}}tokens.length=j;return tokens}})();if(typeof window!=="undefined"){window["lexCss"]=lexCss;window["decodeCss"]=decodeCss}var URI=function(){function parse(uriStr){var m=(""+uriStr).match(URI_RE_);if(!m){return null}return new URI(nullIfAbsent(m[1]),nullIfAbsent(m[2]),nullIfAbsent(m[3]),nullIfAbsent(m[4]),nullIfAbsent(m[5]),nullIfAbsent(m[6]),nullIfAbsent(m[7]))}function create(scheme,credentials,domain,port,path,query,fragment){var uri=new URI(encodeIfExists2(scheme,URI_DISALLOWED_IN_SCHEME_OR_CREDENTIALS_),encodeIfExists2(credentials,URI_DISALLOWED_IN_SCHEME_OR_CREDENTIALS_),encodeIfExists(domain),port>0?port.toString():null,encodeIfExists2(path,URI_DISALLOWED_IN_PATH_),null,encodeIfExists(fragment));if(query){if("string"===typeof query){uri.setRawQuery(query.replace(/[^?&=0-9A-Za-z_\-~.%]/g,encodeOne))}else{uri.setAllParameters(query)}}return uri}function encodeIfExists(unescapedPart){if("string"==typeof unescapedPart){return encodeURIComponent(unescapedPart)}return null}function encodeIfExists2(unescapedPart,extra){if("string"==typeof unescapedPart){return encodeURI(unescapedPart).replace(extra,encodeOne)}return null}function encodeOne(ch){var n=ch.charCodeAt(0);return"%"+"0123456789ABCDEF".charAt(n>>4&15)+"0123456789ABCDEF".charAt(n&15)}function normPath(path){return path.replace(/(^|\/)\.(?:\/|$)/g,"$1").replace(/\/{2,}/g,"/")}var PARENT_DIRECTORY_HANDLER=new RegExp(""+"(/|^)"+"(?:[^./][^/]*|\\.{2,}(?:[^./][^/]*)|\\.{3,}[^/]*)"+"/\\.\\.(?:/|$)");var PARENT_DIRECTORY_HANDLER_RE=new RegExp(PARENT_DIRECTORY_HANDLER);var EXTRA_PARENT_PATHS_RE=/^(?:\.\.\/)*(?:\.\.$)?/;function collapse_dots(path){if(path===null){return null}var p=normPath(path);var r=PARENT_DIRECTORY_HANDLER_RE;for(var q;(q=p.replace(r,"$1"))!=p;p=q){}return p}function resolve(baseUri,relativeUri){var absoluteUri=baseUri.clone();var overridden=relativeUri.hasScheme();if(overridden){absoluteUri.setRawScheme(relativeUri.getRawScheme())}else{overridden=relativeUri.hasCredentials()}if(overridden){absoluteUri.setRawCredentials(relativeUri.getRawCredentials())}else{overridden=relativeUri.hasDomain()}if(overridden){absoluteUri.setRawDomain(relativeUri.getRawDomain())}else{overridden=relativeUri.hasPort()}var rawPath=relativeUri.getRawPath();var simplifiedPath=collapse_dots(rawPath);if(overridden){absoluteUri.setPort(relativeUri.getPort());simplifiedPath=simplifiedPath&&simplifiedPath.replace(EXTRA_PARENT_PATHS_RE,"")}else{overridden=!!rawPath;if(overridden){if(simplifiedPath.charCodeAt(0)!==47){var absRawPath=collapse_dots(absoluteUri.getRawPath()||"").replace(EXTRA_PARENT_PATHS_RE,"");var slash=absRawPath.lastIndexOf("/")+1;simplifiedPath=collapse_dots((slash?absRawPath.substring(0,slash):"")+collapse_dots(rawPath)).replace(EXTRA_PARENT_PATHS_RE,"")}}else{simplifiedPath=simplifiedPath&&simplifiedPath.replace(EXTRA_PARENT_PATHS_RE,"");if(simplifiedPath!==rawPath){absoluteUri.setRawPath(simplifiedPath)}}}if(overridden){absoluteUri.setRawPath(simplifiedPath)}else{overridden=relativeUri.hasQuery()}if(overridden){absoluteUri.setRawQuery(relativeUri.getRawQuery())}else{overridden=relativeUri.hasFragment()}if(overridden){absoluteUri.setRawFragment(relativeUri.getRawFragment())}return absoluteUri}function URI(rawScheme,rawCredentials,rawDomain,port,rawPath,rawQuery,rawFragment){this.scheme_=rawScheme;this.credentials_=rawCredentials;this.domain_=rawDomain;this.port_=port;this.path_=rawPath;this.query_=rawQuery;this.fragment_=rawFragment;this.paramCache_=null}URI.prototype.toString=function(){var out=[];if(null!==this.scheme_){out.push(this.scheme_,":")}if(null!==this.domain_){out.push("//");if(null!==this.credentials_){out.push(this.credentials_,"@")}out.push(this.domain_);if(null!==this.port_){out.push(":",this.port_.toString())}}if(null!==this.path_){out.push(this.path_)}if(null!==this.query_){out.push("?",this.query_)}if(null!==this.fragment_){out.push("#",this.fragment_)}return out.join("")};URI.prototype.clone=function(){return new URI(this.scheme_,this.credentials_,this.domain_,this.port_,this.path_,this.query_,this.fragment_)};URI.prototype.getScheme=function(){return this.scheme_&&decodeURIComponent(this.scheme_).toLowerCase()};URI.prototype.getRawScheme=function(){return this.scheme_};URI.prototype.setScheme=function(newScheme){this.scheme_=encodeIfExists2(newScheme,URI_DISALLOWED_IN_SCHEME_OR_CREDENTIALS_);return this};URI.prototype.setRawScheme=function(newScheme){this.scheme_=newScheme?newScheme:null;return this};URI.prototype.hasScheme=function(){return null!==this.scheme_};URI.prototype.getCredentials=function(){return this.credentials_&&decodeURIComponent(this.credentials_)};URI.prototype.getRawCredentials=function(){return this.credentials_};URI.prototype.setCredentials=function(newCredentials){this.credentials_=encodeIfExists2(newCredentials,URI_DISALLOWED_IN_SCHEME_OR_CREDENTIALS_);return this};URI.prototype.setRawCredentials=function(newCredentials){this.credentials_=newCredentials?newCredentials:null;return this};URI.prototype.hasCredentials=function(){return null!==this.credentials_};URI.prototype.getDomain=function(){return this.domain_&&decodeURIComponent(this.domain_)};URI.prototype.getRawDomain=function(){return this.domain_};URI.prototype.setDomain=function(newDomain){return this.setRawDomain(newDomain&&encodeURIComponent(newDomain))};URI.prototype.setRawDomain=function(newDomain){this.domain_=newDomain?newDomain:null;return this.setRawPath(this.path_)};URI.prototype.hasDomain=function(){return null!==this.domain_};URI.prototype.getPort=function(){return this.port_&&decodeURIComponent(this.port_)};URI.prototype.setPort=function(newPort){if(newPort){newPort=Number(newPort);if(newPort!==(newPort&65535)){throw new Error("Bad port number "+newPort)}this.port_=""+newPort}else{this.port_=null}return this};URI.prototype.hasPort=function(){return null!==this.port_};URI.prototype.getPath=function(){return this.path_&&decodeURIComponent(this.path_)};URI.prototype.getRawPath=function(){return this.path_};URI.prototype.setPath=function(newPath){return this.setRawPath(encodeIfExists2(newPath,URI_DISALLOWED_IN_PATH_))};URI.prototype.setRawPath=function(newPath){if(newPath){newPath=String(newPath);this.path_=!this.domain_||/^\//.test(newPath)?newPath:"/"+newPath}else{this.path_=null}return this};URI.prototype.hasPath=function(){return null!==this.path_};URI.prototype.getQuery=function(){return this.query_&&decodeURIComponent(this.query_).replace(/\+/g," ")};URI.prototype.getRawQuery=function(){return this.query_};URI.prototype.setQuery=function(newQuery){this.paramCache_=null;this.query_=encodeIfExists(newQuery);return this};URI.prototype.setRawQuery=function(newQuery){this.paramCache_=null;this.query_=newQuery?newQuery:null;return this};URI.prototype.hasQuery=function(){return null!==this.query_};URI.prototype.setAllParameters=function(params){if(typeof params==="object"){if(!(params instanceof Array)&&(params instanceof Object||Object.prototype.toString.call(params)!=="[object Array]")){var newParams=[];var i=-1;for(var k in params){var v=params[k];if("string"===typeof v){newParams[++i]=k;newParams[++i]=v}}params=newParams}}this.paramCache_=null;var queryBuf=[];var separator="";for(var j=0;j<params.length;){var k=params[j++];var v=params[j++];queryBuf.push(separator,encodeURIComponent(k.toString()));separator="&";if(v){queryBuf.push("=",encodeURIComponent(v.toString()))}}this.query_=queryBuf.join("");return this};URI.prototype.checkParameterCache_=function(){if(!this.paramCache_){var q=this.query_;if(!q){this.paramCache_=[]}else{var cgiParams=q.split(/[&\?]/);var out=[];var k=-1;for(var i=0;i<cgiParams.length;++i){var m=cgiParams[i].match(/^([^=]*)(?:=(.*))?$/);out[++k]=decodeURIComponent(m[1]).replace(/\+/g," ");out[++k]=decodeURIComponent(m[2]||"").replace(/\+/g," ")}this.paramCache_=out}}};URI.prototype.setParameterValues=function(key,values){if(typeof values==="string"){values=[values]}this.checkParameterCache_();var newValueIndex=0;var pc=this.paramCache_;var params=[];for(var i=0,k=0;i<pc.length;i+=2){if(key===pc[i]){if(newValueIndex<values.length){params.push(key,values[newValueIndex++])}}else{params.push(pc[i],pc[i+1])}}while(newValueIndex<values.length){params.push(key,values[newValueIndex++])}this.setAllParameters(params);return this};URI.prototype.removeParameter=function(key){return this.setParameterValues(key,[])};URI.prototype.getAllParameters=function(){this.checkParameterCache_();return this.paramCache_.slice(0,this.paramCache_.length)};URI.prototype.getParameterValues=function(paramNameUnescaped){this.checkParameterCache_();var values=[];for(var i=0;i<this.paramCache_.length;i+=2){if(paramNameUnescaped===this.paramCache_[i]){values.push(this.paramCache_[i+1])}}return values};URI.prototype.getParameterMap=function(paramNameUnescaped){this.checkParameterCache_();var paramMap={};for(var i=0;i<this.paramCache_.length;i+=2){var key=this.paramCache_[i++],value=this.paramCache_[i++];if(!(key in paramMap)){paramMap[key]=[value]}else{paramMap[key].push(value)}}return paramMap};URI.prototype.getParameterValue=function(paramNameUnescaped){this.checkParameterCache_();for(var i=0;i<this.paramCache_.length;i+=2){if(paramNameUnescaped===this.paramCache_[i]){return this.paramCache_[i+1]}}return null};URI.prototype.getFragment=function(){return this.fragment_&&decodeURIComponent(this.fragment_)};URI.prototype.getRawFragment=function(){return this.fragment_};URI.prototype.setFragment=function(newFragment){this.fragment_=newFragment?encodeURIComponent(newFragment):null;return this};URI.prototype.setRawFragment=function(newFragment){this.fragment_=newFragment?newFragment:null;return this};URI.prototype.hasFragment=function(){return null!==this.fragment_};function nullIfAbsent(matchPart){return"string"==typeof matchPart&&matchPart.length>0?matchPart:null}var URI_RE_=new RegExp("^"+"(?:"+"([^:/?#]+)"+":)?"+"(?://"+"(?:([^/?#]*)@)?"+"([^/?#:@]*)"+"(?::([0-9]+))?"+")?"+"([^?#]+)?"+"(?:\\?([^#]*))?"+"(?:#(.*))?"+"$");var URI_DISALLOWED_IN_SCHEME_OR_CREDENTIALS_=/[#\/\?@]/g;var URI_DISALLOWED_IN_PATH_=/[\#\?]/g;URI.parse=parse;URI.create=create;URI.resolve=resolve;URI.collapse_dots=collapse_dots;URI.utils={mimeTypeOf:function(uri){var uriObj=parse(uri);if(/\.html$/.test(uriObj.getPath())){return"text/html"}else{return"application/javascript"}},resolve:function(base,uri){if(base){return resolve(parse(base),parse(uri)).toString()}else{return""+uri}}};return URI}();if(typeof window!=="undefined"){window["URI"]=URI}var sanitizeCssProperty=undefined;var sanitizeCssSelectorList=undefined;var sanitizeStylesheet=undefined;var sanitizeStylesheetWithExternals=undefined;var sanitizeMediaQuery=undefined;(function(){var NOEFFECT_URL='url("about:blank")';var NORM_URL_REGEXP=/[\n\f\r\"\'()*<>]/g;var NORM_URL_REPLACEMENTS={"\n":"%0a","\f":"%0c","\r":"%0d",'"':"%22","'":"%27","(":"%28",")":"%29","*":"%2a","<":"%3c",">":"%3e"};function normalizeUrl(s){if("string"===typeof s){return'url("'+s.replace(NORM_URL_REGEXP,normalizeUrlChar)+'")'}else{return NOEFFECT_URL}}function normalizeUrlChar(ch){return NORM_URL_REPLACEMENTS[ch]}var URI_SCHEME_RE=new RegExp("^"+"(?:"+"([^:/?# ]+)"+":)?");var ALLOWED_URI_SCHEMES=/^(?:https?|mailto)$/i;function resolveUri(baseUri,uri){if(baseUri){return URI.utils.resolve(baseUri,uri)}return uri}function safeUri(uri,prop,naiveUriRewriter){if(!naiveUriRewriter){return null}var parsed=(""+uri).match(URI_SCHEME_RE);if(parsed&&(!parsed[1]||ALLOWED_URI_SCHEMES.test(parsed[1]))){return naiveUriRewriter(uri,prop)}else{return null}}function withoutVendorPrefix(ident){return ident.replace(/^-(?:apple|css|epub|khtml|moz|mso?|o|rim|wap|webkit|xv)-(?=[a-z])/,"")}sanitizeCssProperty=function(){function unionArrays(arrs){var map={};for(var i=arrs.length;--i>=0;){var arr=arrs[i];for(var j=arr.length;--j>=0;){map[arr[j]]=ALLOWED_LITERAL}}return map}var ALLOWED_LITERAL={};return function sanitize(property,tokens,opt_naiveUriRewriter,opt_baseUri,opt_idSuffix){var propertyKey=withoutVendorPrefix(property);var propertySchema=cssSchema[propertyKey];if(!propertySchema||"object"!==typeof propertySchema){tokens.length=0;return}var propBits=propertySchema["cssPropBits"];function sanitizeFunctionCall(tokens,start){var parenDepth=1,end=start+1,n=tokens.length;while(end<n&&parenDepth){var token=tokens[end++];parenDepth+=token===")"?-1:/^[^"']*\($/.test(token)}if(!parenDepth){var fnToken=tokens[start].toLowerCase();var bareFnToken=withoutVendorPrefix(fnToken);var fnTokens=tokens.splice(start,end-start,"");var fns=propertySchema["cssFns"];for(var i=0,nFns=fns.length;i<nFns;++i){if(fns[i].substring(0,bareFnToken.length)==bareFnToken){fnTokens[0]=fnTokens[fnTokens.length-1]="";sanitize(fns[i],fnTokens,opt_naiveUriRewriter,opt_baseUri);return fnToken+fnTokens.join(" ")+")"}}}return""}var stringDisposition=propBits&(CSS_PROP_BIT_URL|CSS_PROP_BIT_UNRESERVED_WORD);var identDisposition=propBits&(CSS_PROP_BIT_GLOBAL_NAME|CSS_PROP_BIT_PROPERTY_NAME);var lastQuoted=NaN;var i=0,k=0;for(;i<tokens.length;++i){var token=tokens[i].toLowerCase();var cc=token.charCodeAt(0),cc1,cc2,isnum1,isnum2,end;var litGroup,litMap;token=cc===" ".charCodeAt(0)?"":cc==='"'.charCodeAt(0)?stringDisposition===CSS_PROP_BIT_URL?opt_naiveUriRewriter?normalizeUrl(safeUri(resolveUri(opt_baseUri,decodeCss(tokens[i].substring(1,token.length-1))),propertyKey,opt_naiveUriRewriter)):"":propBits&CSS_PROP_BIT_QSTRING&&!(stringDisposition&stringDisposition-1)?token:"":token==="inherit"?token:(litGroup=propertySchema["cssLitGroup"],litMap=litGroup?propertySchema["cssLitMap"]||(propertySchema["cssLitMap"]=unionArrays(litGroup)):ALLOWED_LITERAL,litMap[withoutVendorPrefix(token)]===ALLOWED_LITERAL)?token:cc==="#".charCodeAt(0)&&/^#(?:[0-9a-f]{3}){1,2}$/.test(token)?propBits&CSS_PROP_BIT_HASH_VALUE?token:"":"0".charCodeAt(0)<=cc&&cc<="9".charCodeAt(0)?propBits&CSS_PROP_BIT_QUANTITY?token:"":(cc1=token.charCodeAt(1),cc2=token.charCodeAt(2),isnum1="0".charCodeAt(0)<=cc1&&cc1<="9".charCodeAt(0),isnum2="0".charCodeAt(0)<=cc2&&cc2<="9".charCodeAt(0),cc==="+".charCodeAt(0)&&(isnum1||cc1===".".charCodeAt(0)&&isnum2))?propBits&CSS_PROP_BIT_QUANTITY?(isnum1?"":"0")+token.substring(1):"":cc==="-".charCodeAt(0)&&(isnum1||cc1===".".charCodeAt(0)&&isnum2)?propBits&CSS_PROP_BIT_NEGATIVE_QUANTITY?(isnum1?"-":"-0")+token.substring(1):propBits&CSS_PROP_BIT_QUANTITY?"0":"":cc===".".charCodeAt(0)&&isnum1?propBits&CSS_PROP_BIT_QUANTITY?"0"+token:"":'url("'===token.substring(0,5)?opt_naiveUriRewriter&&propBits&CSS_PROP_BIT_URL?normalizeUrl(safeUri(resolveUri(opt_baseUri,tokens[i].substring(5,token.length-2)),propertyKey,opt_naiveUriRewriter)):"":token.charAt(token.length-1)==="("?sanitizeFunctionCall(tokens,i):identDisposition&&/^-?[a-z_][\w\-]*$/.test(token)&&!/__$/.test(token)?opt_idSuffix&&identDisposition===CSS_PROP_BIT_GLOBAL_NAME?tokens[i]+opt_idSuffix:identDisposition===CSS_PROP_BIT_PROPERTY_NAME&&cssSchema[token]&&"number"===typeof cssSchema[token].cssPropBits?token:"":/^\w+$/.test(token)&&stringDisposition===CSS_PROP_BIT_UNRESERVED_WORD&&propBits&CSS_PROP_BIT_QSTRING?lastQuoted+1===k?(tokens[lastQuoted]=tokens[lastQuoted].substring(0,tokens[lastQuoted].length-1)+" "+token+'"',token=""):(lastQuoted=k,'"'+token+'"'):"";
if(token){tokens[k++]=token}}if(k===1&&tokens[0]===NOEFFECT_URL){k=0}tokens.length=k}}();var PSEUDO_SELECTOR_WHITELIST=new RegExp("^(active|after|before|blank|checked|default|disabled"+"|drop|empty|enabled|first|first-child|first-letter"+"|first-line|first-of-type|fullscreen|focus|hover"+"|in-range|indeterminate|invalid|last-child|last-of-type"+"|left|link|only-child|only-of-type|optional|out-of-range"+"|placeholder-shown|read-only|read-write|required|right"+"|root|scope|user-error|valid|visited"+")$");var COMBINATOR={};COMBINATOR[">"]=COMBINATOR["+"]=COMBINATOR["~"]=COMBINATOR;sanitizeCssSelectorList=function(selectors,virtualization,opt_onUntranslatableSelector){var containerClass=virtualization.containerClass;var idSuffix=virtualization.idSuffix;var tagPolicy=virtualization.tagPolicy;var sanitized=[];var k=0,i,inBrackets=0,tok;for(i=0;i<selectors.length;++i){tok=selectors[i];if(tok=="("||tok=="["?(++inBrackets,true):tok==")"||tok=="]"?(inBrackets&&--inBrackets,true):!(selectors[i]==" "&&(inBrackets||COMBINATOR[selectors[i-1]]===COMBINATOR||COMBINATOR[selectors[i+1]]===COMBINATOR))){selectors[k++]=selectors[i]}}selectors.length=k;var n=selectors.length,start=0;for(i=0;i<n;++i){if(selectors[i]===","){if(!processComplexSelector(start,i)){return null}start=i+1}}if(!processComplexSelector(start,n)){return null}function processComplexSelector(start,end){if(selectors[start]===" "){++start}if(end-1!==start&&selectors[end]===" "){--end}var out=[];var lastOperator=start;var valid=true;for(var i=start;valid&&i<end;++i){var tok=selectors[i];if(COMBINATOR[tok]===COMBINATOR||tok===" "){if(!processCompoundSelector(lastOperator,i,tok)){valid=false}else{lastOperator=i+1}}}if(!processCompoundSelector(lastOperator,end,"")){valid=false}function processCompoundSelector(start,end,combinator){var element,classId,attrs,pseudoSelector,tok,valid=true;element="";if(start<end){tok=selectors[start];if(tok==="*"){++start;element=tok}else if(/^[a-zA-Z]/.test(tok)){var decision=tagPolicy(tok.toLowerCase(),[]);if(decision){if("tagName"in decision){tok=decision["tagName"]}++start;element=tok}}}classId="";attrs="";pseudoSelector="";for(;valid&&start<end;++start){tok=selectors[start];if(tok.charAt(0)==="#"){if(/^#_|__$|[^\w#:\-]/.test(tok)){valid=false}else{classId+=tok+idSuffix}}else if(tok==="."){if(++start<end&&/^[0-9A-Za-z:_\-]+$/.test(tok=selectors[start])&&!/^_|__$/.test(tok)){classId+="."+tok}else{valid=false}}else if(start+1<end&&selectors[start]==="["){++start;var vAttr=selectors[start++].toLowerCase();var atype=html4.ATTRIBS[element+"::"+vAttr];if(atype!==+atype){atype=html4.ATTRIBS["*::"+vAttr]}var rAttr;if(virtualization.virtualizeAttrName){rAttr=virtualization.virtualizeAttrName(element,vAttr);if(typeof rAttr!=="string"){valid=false;rAttr=vAttr}if(valid&&atype!==+atype){atype=html4.atype["NONE"]}}else{rAttr=vAttr;if(atype!==+atype){valid=false}}var op="",value="",ignoreCase=false;if(/^[~^$*|]?=$/.test(selectors[start])){op=selectors[start++];value=selectors[start++];if(/^[0-9A-Za-z:_\-]+$/.test(value)){value='"'+value+'"'}else if(value==="]"){value='""';--start}if(!/^"([^\"\\]|\\.)*"$/.test(value)){valid=false}ignoreCase=selectors[start]==="i";if(ignoreCase){++start}}if(selectors[start]!=="]"){++start;valid=false}switch(atype){case html4.atype["CLASSES"]:case html4.atype["LOCAL_NAME"]:case html4.atype["NONE"]:break;case html4.atype["GLOBAL_NAME"]:case html4.atype["ID"]:case html4.atype["IDREF"]:if((op==="="||op==="~="||op==="$=")&&value!='""'&&!ignoreCase){value='"'+value.substring(1,value.length-1)+idSuffix+'"'}else if(op==="|="||op===""){}else{valid=false}break;case html4.atype["URI"]:case html4.atype["URI_FRAGMENT"]:if(op!==""){valid=false}break;default:valid=false}if(valid){attrs+="["+rAttr.replace(/[^\w-]/g,"\\$&")+op+value+(ignoreCase?" i]":"]")}}else if(start<end&&selectors[start]===":"){tok=selectors[++start];if(PSEUDO_SELECTOR_WHITELIST.test(tok)){pseudoSelector+=":"+tok}else{break}}else{break}}if(start!==end){valid=false}if(valid){var selector=(element+classId).replace(/[^ .*#\w-]/g,"\\$&")+attrs+pseudoSelector+combinator;if(selector){out.push(selector)}}return valid}if(valid){if(out.length){var safeSelector=out.join("");if(containerClass!==null){safeSelector="."+containerClass+" "+safeSelector}sanitized.push(safeSelector)}return true}else{return!opt_onUntranslatableSelector||opt_onUntranslatableSelector(selectors.slice(start,end))}}return sanitized};(function(){var MEDIA_TYPE="(?:"+"all|aural|braille|embossed|handheld|print"+"|projection|screen|speech|tty|tv"+")";var MEDIA_FEATURE="(?:"+"(?:min-|max-)?"+"(?:"+("(?:device-)?"+"(?:aspect-ratio|height|width)"+"|color(?:-index)?"+"|monochrome"+"|orientation"+"|resolution")+")"+"|grid"+"|hover"+"|luminosity"+"|pointer"+"|scan"+"|script"+")";var LENGTH_UNIT="(?:p[cxt]|[cem]m|in|dpi|dppx|dpcm|%)";var CSS_VALUE="-?(?:"+"[a-z]\\w+(?:-\\w+)*"+"|\\d+(?: / \\d+|(?:\\.\\d+)?"+LENGTH_UNIT+"?)"+")";var MEDIA_EXPR="\\( "+MEDIA_FEATURE+" (?:"+": "+CSS_VALUE+" )?\\)";var MEDIA_QUERY="(?:"+"(?:(?:(?:only|not) )?"+MEDIA_TYPE+"|"+MEDIA_EXPR+")"+"(?: and ?"+MEDIA_EXPR+")*"+")";var STARTS_WITH_KEYWORD_REGEXP=/^\w/;var MEDIA_QUERY_LIST_REGEXP=new RegExp("^"+MEDIA_QUERY+"(?: , "+MEDIA_QUERY+")*"+"$","i");sanitizeMediaQuery=function(cssTokens){cssTokens=cssTokens.slice();var nTokens=cssTokens.length,k=0;for(var i=0;i<nTokens;++i){var tok=cssTokens[i];if(tok!=" "){cssTokens[k++]=tok}}cssTokens.length=k;var css=cssTokens.join(" ");css=!css.length?"":!MEDIA_QUERY_LIST_REGEXP.test(css)?"not all":STARTS_WITH_KEYWORD_REGEXP.test(css)?css:"not all , "+css;return css}})();(function(){function cssParseUri(candidate){var string1=/^\s*["]([^"]*)["]\s*$/;var string2=/^\s*[']([^']*)[']\s*$/;var url1=/^\s*url\s*[(]["]([^"]*)["][)]\s*$/;var url2=/^\s*url\s*[(][']([^']*)['][)]\s*$/;var url3=/^\s*url\s*[(]([^)]*)[)]\s*$/;var match;if(match=string1.exec(candidate)){return match[1]}else if(match=string2.exec(candidate)){return match[1]}else if(match=url1.exec(candidate)){return match[1]}else if(match=url2.exec(candidate)){return match[1]}else if(match=url3.exec(candidate)){return match[1]}return null}function sanitizeStylesheetInternal(baseUri,cssText,virtualization,naiveUriRewriter,naiveUriFetcher,continuation,opt_importCount){var safeCss=void 0;var importCount=opt_importCount||[0];var blockStack=[];var elide=false;parseCssStylesheet(cssText,{startStylesheet:function(){safeCss=[]},endStylesheet:function(){},startAtrule:function(atIdent,headerArray){if(elide){atIdent=null}else if(atIdent==="@media"){safeCss.push("@media"," ",sanitizeMediaQuery(headerArray))}else if(atIdent==="@keyframes"||atIdent==="@-webkit-keyframes"){var animationId=headerArray[0];if(headerArray.length===1&&!/__$|[^\w\-]/.test(animationId)){safeCss.push(atIdent," ",animationId+virtualization.idSuffix);atIdent="@keyframes"}else{atIdent=null}}else{if(atIdent==="@import"&&headerArray.length>0){atIdent=null;if("function"===typeof continuation){var mediaQuery=sanitizeMediaQuery(headerArray.slice(1));if(mediaQuery!=="not all"){++importCount[0];var placeholder=[];safeCss.push(placeholder);var cssUrl=safeUri(resolveUri(baseUri,cssParseUri(headerArray[0])),function(result){var sanitized=sanitizeStylesheetInternal(cssUrl,result.html,virtualization,naiveUriRewriter,naiveUriFetcher,continuation,importCount);--importCount[0];var safeImportedCss=mediaQuery?{toString:function(){return"@media "+mediaQuery+" {"+sanitized.result+"}"}}:sanitized.result;placeholder[0]=safeImportedCss;continuation(safeImportedCss,!!importCount[0])},naiveUriFetcher)}}else{if(window.console){window.console.log("@import "+headerArray.join(" ")+" elided")}}}}elide=!atIdent;blockStack.push(atIdent)},endAtrule:function(){blockStack.pop();if(!elide){safeCss.push(";")}checkElide()},startBlock:function(){if(!elide){safeCss.push("{")}},endBlock:function(){if(!elide){safeCss.push("}");elide=true}},startRuleset:function(selectorArray){if(!elide){var selector=void 0;if(blockStack[blockStack.length-1]==="@keyframes"){selector=selectorArray.join(" ").match(/^ *(?:from|to|\d+(?:\.\d+)?%) *(?:, *(?:from|to|\d+(?:\.\d+)?%) *)*$/i);elide=!selector;if(selector){selector=selector[0].replace(/ +/g,"")}}else{var selectors=sanitizeCssSelectorList(selectorArray,virtualization);if(!selectors||!selectors.length){elide=true}else{selector=selectors.join(", ")}}if(!elide){safeCss.push(selector,"{")}}blockStack.push(null)},endRuleset:function(){blockStack.pop();if(!elide){safeCss.push("}")}checkElide()},declaration:function(property,valueArray){if(!elide){var isImportant=false;var nValues=valueArray.length;if(nValues>=2&&valueArray[nValues-2]==="!"&&valueArray[nValues-1].toLowerCase()==="important"){isImportant=true;valueArray.length-=2}sanitizeCssProperty(property,valueArray,naiveUriRewriter,baseUri,virtualization.idSuffix);if(valueArray.length){safeCss.push(property,":",valueArray.join(" "),isImportant?" !important;":";")}}}});function checkElide(){elide=blockStack.length&&blockStack[blockStack.length-1]===null}return{result:{toString:function(){return safeCss.join("")}},moreToCome:!!importCount[0]}}sanitizeStylesheet=function(baseUri,cssText,virtualization,naiveUriRewriter){return sanitizeStylesheetInternal(baseUri,cssText,virtualization,naiveUriRewriter,undefined,undefined).result.toString()};sanitizeStylesheetWithExternals=function(baseUri,cssText,virtualization,naiveUriRewriter,naiveUriFetcher,continuation){return sanitizeStylesheetInternal(baseUri,cssText,virtualization,naiveUriRewriter,naiveUriFetcher,continuation)}})()})();if(typeof window!=="undefined"){window["sanitizeCssProperty"]=sanitizeCssProperty;window["sanitizeCssSelectorList"]=sanitizeCssSelectorList;window["sanitizeStylesheet"]=sanitizeStylesheet;window["sanitizeMediaQuery"]=sanitizeMediaQuery}if("I".toLowerCase()!=="i"){throw"I/i problem"}var parseCssStylesheet;var parseCssDeclarations;(function(){parseCssStylesheet=function(cssText,handler){var toks=lexCss(cssText);if(handler["startStylesheet"]){handler["startStylesheet"]()}for(var i=0,n=toks.length;i<n;){i=toks[i]===" "?i+1:statement(toks,i,n,handler)}if(handler["endStylesheet"]){handler["endStylesheet"]()}};function statement(toks,i,n,handler){if(i<n){var tok=toks[i];if(tok.charAt(0)==="@"){return atrule(toks,i,n,handler,true)}else{return ruleset(toks,i,n,handler)}}else{return i}}function atrule(toks,i,n,handler,blockok){var start=i++;while(i<n&&toks[i]!=="{"&&toks[i]!==";"){++i}if(i<n&&(blockok||toks[i]===";")){var s=start+1,e=i;if(s<n&&toks[s]===" "){++s}if(e>s&&toks[e-1]===" "){--e}if(handler["startAtrule"]){handler["startAtrule"](toks[start].toLowerCase(),toks.slice(s,e))}i=toks[i]==="{"?block(toks,i,n,handler):i+1;if(handler["endAtrule"]){handler["endAtrule"]()}}return i}function block(toks,i,n,handler){++i;if(handler["startBlock"]){handler["startBlock"]()}while(i<n){var ch=toks[i].charAt(0);if(ch=="}"){++i;break}if(ch===" "||ch===";"){i=i+1}else if(ch==="@"){i=atrule(toks,i,n,handler,false)}else if(ch==="{"){i=block(toks,i,n,handler)}else{i=ruleset(toks,i,n,handler)}}if(handler["endBlock"]){handler["endBlock"]()}return i}function ruleset(toks,i,n,handler){var s=i,e=selector(toks,i,n,true);if(e<0){e=~e;return e===s?e+1:e}var tok=toks[e];if(tok!=="{"){return e===s?e+1:e}i=e+1;if(e>s&&toks[e-1]===" "){--e}if(handler["startRuleset"]){handler["startRuleset"](toks.slice(s,e))}while(i<n){tok=toks[i];if(tok==="}"){++i;break}if(tok===" "){i=i+1}else{i=declaration(toks,i,n,handler)}}if(handler["endRuleset"]){handler["endRuleset"]()}return i}function selector(toks,i,n,allowSemi){var s=i;var tok;var brackets=[],stackLast=-1;for(;i<n;++i){tok=toks[i].charAt(0);if(tok==="["||tok==="("){brackets[++stackLast]=tok}else if(tok==="]"&&brackets[stackLast]==="["||tok===")"&&brackets[stackLast]==="("){--stackLast}else if(tok==="{"||tok==="}"||tok===";"||tok==="@"||tok===":"&&!allowSemi){break}}if(stackLast>=0){i=~(i+1)}return i}var ident=/^-?[a-z]/i;function skipDeclaration(toks,i,n){while(i<n&&toks[i]!==";"&&toks[i]!=="}"){++i}return i<n&&toks[i]===";"?i+1:i}function declaration(toks,i,n,handler){var property=toks[i++];if(!ident.test(property)){return skipDeclaration(toks,i,n)}var tok;if(i<n&&toks[i]===" "){++i}if(i==n||toks[i]!==":"){return skipDeclaration(toks,i,n)}++i;if(i<n&&toks[i]===" "){++i}var s=i,e=selector(toks,i,n,false);if(e<0){e=~e}else{var value=[],valuelen=0;for(var j=s;j<e;++j){tok=toks[j];if(tok!==" "){value[valuelen++]=tok}}if(e<n){do{tok=toks[e];if(tok===";"||tok==="}"){break}valuelen=0}while(++e<n);if(tok===";"){++e}}if(valuelen&&handler["declaration"]){handler["declaration"](property.toLowerCase(),value)}}return e}parseCssDeclarations=function(cssText,handler){var toks=lexCss(cssText);for(var i=0,n=toks.length;i<n;){i=toks[i]!==" "?declaration(toks,i,n,handler):i+1}}})();if(typeof window!=="undefined"){window["parseCssStylesheet"]=parseCssStylesheet;window["parseCssDeclarations"]=parseCssDeclarations}var html4={};html4.atype={NONE:0,URI:1,URI_FRAGMENT:11,SCRIPT:2,STYLE:3,HTML:12,ID:4,IDREF:5,IDREFS:6,GLOBAL_NAME:7,LOCAL_NAME:8,CLASSES:9,FRAME_TARGET:10,MEDIA_QUERY:13};html4["atype"]=html4.atype;html4.ATTRIBS={"*::class":9,"*::dir":0,"*::draggable":0,"*::hidden":0,"*::id":4,"*::inert":0,"*::itemprop":0,"*::itemref":6,"*::itemscope":0,"*::lang":0,"*::onblur":2,"*::onchange":2,"*::onclick":2,"*::ondblclick":2,"*::onerror":2,"*::onfocus":2,"*::onkeydown":2,"*::onkeypress":2,"*::onkeyup":2,"*::onload":2,"*::onmousedown":2,"*::onmousemove":2,"*::onmouseout":2,"*::onmouseover":2,"*::onmouseup":2,"*::onreset":2,"*::onscroll":2,"*::onselect":2,"*::onsubmit":2,"*::ontouchcancel":2,"*::ontouchend":2,"*::ontouchenter":2,"*::ontouchleave":2,"*::ontouchmove":2,"*::ontouchstart":2,"*::onunload":2,"*::spellcheck":0,"*::style":3,"*::title":0,"*::translate":0,"a::accesskey":0,"a::coords":0,"a::href":1,"a::hreflang":0,"a::name":7,"a::onblur":2,"a::onfocus":2,"a::shape":0,"a::tabindex":0,"a::target":10,"a::type":0,"area::accesskey":0,"area::alt":0,"area::coords":0,"area::href":1,"area::nohref":0,"area::onblur":2,"area::onfocus":2,"area::shape":0,"area::tabindex":0,"area::target":10,"audio::controls":0,"audio::loop":0,"audio::mediagroup":5,"audio::muted":0,"audio::preload":0,"audio::src":1,"bdo::dir":0,"blockquote::cite":1,"br::clear":0,"button::accesskey":0,"button::disabled":0,"button::name":8,"button::onblur":2,"button::onfocus":2,"button::tabindex":0,"button::type":0,"button::value":0,"canvas::height":0,"canvas::width":0,"caption::align":0,"col::align":0,"col::char":0,"col::charoff":0,"col::span":0,"col::valign":0,"col::width":0,"colgroup::align":0,"colgroup::char":0,"colgroup::charoff":0,"colgroup::span":0,"colgroup::valign":0,"colgroup::width":0,"command::checked":0,"command::command":5,"command::disabled":0,"command::icon":1,"command::label":0,"command::radiogroup":0,"command::type":0,"data::value":0,"del::cite":1,"del::datetime":0,"details::open":0,"dir::compact":0,"div::align":0,"dl::compact":0,"fieldset::disabled":0,"font::color":0,"font::face":0,"font::size":0,"form::accept":0,"form::action":1,"form::autocomplete":0,"form::enctype":0,"form::method":0,"form::name":7,"form::novalidate":0,"form::onreset":2,"form::onsubmit":2,"form::target":10,"h1::align":0,"h2::align":0,"h3::align":0,"h4::align":0,"h5::align":0,"h6::align":0,"hr::align":0,"hr::noshade":0,"hr::size":0,"hr::width":0,"iframe::align":0,"iframe::frameborder":0,"iframe::height":0,"iframe::marginheight":0,"iframe::marginwidth":0,"iframe::width":0,"img::align":0,"img::alt":0,"img::border":0,"img::height":0,"img::hspace":0,"img::ismap":0,"img::name":7,"img::src":1,"img::usemap":11,"img::vspace":0,"img::width":0,"input::accept":0,"input::accesskey":0,"input::align":0,"input::alt":0,"input::autocomplete":0,"input::checked":0,"input::disabled":0,"input::inputmode":0,"input::ismap":0,"input::list":5,"input::max":0,"input::maxlength":0,"input::min":0,"input::multiple":0,"input::name":8,"input::onblur":2,"input::onchange":2,"input::onfocus":2,"input::onselect":2,"input::placeholder":0,"input::readonly":0,"input::required":0,"input::size":0,"input::src":1,"input::step":0,"input::tabindex":0,"input::type":0,"input::usemap":11,"input::value":0,"ins::cite":1,"ins::datetime":0,"label::accesskey":0,"label::for":5,"label::onblur":2,"label::onfocus":2,"legend::accesskey":0,"legend::align":0,"li::type":0,"li::value":0,"map::name":7,"menu::compact":0,"menu::label":0,"menu::type":0,"meter::high":0,"meter::low":0,"meter::max":0,"meter::min":0,"meter::value":0,"ol::compact":0,"ol::reversed":0,"ol::start":0,"ol::type":0,"optgroup::disabled":0,"optgroup::label":0,"option::disabled":0,"option::label":0,"option::selected":0,"option::value":0,"output::for":6,"output::name":8,"p::align":0,"pre::width":0,"progress::max":0,"progress::min":0,"progress::value":0,"q::cite":1,"select::autocomplete":0,"select::disabled":0,"select::multiple":0,"select::name":8,"select::onblur":2,"select::onchange":2,"select::onfocus":2,"select::required":0,"select::size":0,"select::tabindex":0,"source::type":0,"table::align":0,"table::bgcolor":0,"table::border":0,"table::cellpadding":0,"table::cellspacing":0,"table::frame":0,"table::rules":0,"table::summary":0,"table::width":0,"tbody::align":0,"tbody::char":0,"tbody::charoff":0,"tbody::valign":0,"td::abbr":0,"td::align":0,"td::axis":0,"td::bgcolor":0,"td::char":0,"td::charoff":0,"td::colspan":0,"td::headers":6,"td::height":0,"td::nowrap":0,"td::rowspan":0,"td::scope":0,"td::valign":0,"td::width":0,"textarea::accesskey":0,"textarea::autocomplete":0,"textarea::cols":0,"textarea::disabled":0,"textarea::inputmode":0,"textarea::name":8,"textarea::onblur":2,"textarea::onchange":2,"textarea::onfocus":2,"textarea::onselect":2,"textarea::placeholder":0,"textarea::readonly":0,"textarea::required":0,"textarea::rows":0,"textarea::tabindex":0,"textarea::wrap":0,"tfoot::align":0,"tfoot::char":0,"tfoot::charoff":0,"tfoot::valign":0,"th::abbr":0,"th::align":0,"th::axis":0,"th::bgcolor":0,"th::char":0,"th::charoff":0,"th::colspan":0,"th::headers":6,"th::height":0,"th::nowrap":0,"th::rowspan":0,"th::scope":0,"th::valign":0,"th::width":0,"thead::align":0,"thead::char":0,"thead::charoff":0,"thead::valign":0,"tr::align":0,"tr::bgcolor":0,"tr::char":0,"tr::charoff":0,"tr::valign":0,"track::default":0,"track::kind":0,"track::label":0,"track::srclang":0,"ul::compact":0,"ul::type":0,"video::controls":0,"video::height":0,"video::loop":0,"video::mediagroup":5,"video::muted":0,"video::poster":1,"video::preload":0,"video::src":1,"video::width":0};html4["ATTRIBS"]=html4.ATTRIBS;html4.eflags={OPTIONAL_ENDTAG:1,EMPTY:2,CDATA:4,RCDATA:8,UNSAFE:16,FOLDABLE:32,SCRIPT:64,STYLE:128,VIRTUALIZED:256};html4["eflags"]=html4.eflags;html4.ELEMENTS={a:0,abbr:0,acronym:0,address:0,applet:272,area:2,article:0,aside:0,audio:0,b:0,base:274,basefont:274,bdi:0,bdo:0,big:0,blockquote:0,body:305,br:2,button:0,canvas:0,caption:0,center:0,cite:0,code:0,col:2,colgroup:1,command:2,data:0,datalist:0,dd:1,del:0,details:0,dfn:0,dialog:272,dir:0,div:0,dl:0,dt:1,em:0,fieldset:0,figcaption:0,figure:0,font:0,footer:0,form:0,frame:274,frameset:272,h1:0,h2:0,h3:0,h4:0,h5:0,h6:0,head:305,header:0,hgroup:0,hr:2,html:305,i:0,iframe:4,img:2,input:2,ins:0,isindex:274,kbd:0,keygen:274,label:0,legend:0,li:1,link:274,map:0,mark:0,menu:0,meta:274,meter:0,nav:0,nobr:0,noembed:276,noframes:276,noscript:276,object:272,ol:0,optgroup:0,option:1,output:0,p:1,param:274,pre:0,progress:0,q:0,s:0,samp:0,script:84,section:0,select:0,small:0,source:2,span:0,strike:0,strong:0,style:148,sub:0,summary:0,sup:0,table:0,tbody:1,td:1,textarea:8,tfoot:1,th:1,thead:1,time:0,title:280,tr:1,track:2,tt:0,u:0,ul:0,"var":0,video:0,wbr:2};html4["ELEMENTS"]=html4.ELEMENTS;html4.ELEMENT_DOM_INTERFACES={a:"HTMLAnchorElement",abbr:"HTMLElement",acronym:"HTMLElement",address:"HTMLElement",applet:"HTMLAppletElement",area:"HTMLAreaElement",article:"HTMLElement",aside:"HTMLElement",audio:"HTMLAudioElement",b:"HTMLElement",base:"HTMLBaseElement",basefont:"HTMLBaseFontElement",bdi:"HTMLElement",bdo:"HTMLElement",big:"HTMLElement",blockquote:"HTMLQuoteElement",body:"HTMLBodyElement",br:"HTMLBRElement",button:"HTMLButtonElement",canvas:"HTMLCanvasElement",caption:"HTMLTableCaptionElement",center:"HTMLElement",cite:"HTMLElement",code:"HTMLElement",col:"HTMLTableColElement",colgroup:"HTMLTableColElement",command:"HTMLCommandElement",data:"HTMLElement",datalist:"HTMLDataListElement",dd:"HTMLElement",del:"HTMLModElement",details:"HTMLDetailsElement",dfn:"HTMLElement",dialog:"HTMLDialogElement",dir:"HTMLDirectoryElement",div:"HTMLDivElement",dl:"HTMLDListElement",dt:"HTMLElement",em:"HTMLElement",fieldset:"HTMLFieldSetElement",figcaption:"HTMLElement",figure:"HTMLElement",font:"HTMLFontElement",footer:"HTMLElement",form:"HTMLFormElement",frame:"HTMLFrameElement",frameset:"HTMLFrameSetElement",h1:"HTMLHeadingElement",h2:"HTMLHeadingElement",h3:"HTMLHeadingElement",h4:"HTMLHeadingElement",h5:"HTMLHeadingElement",h6:"HTMLHeadingElement",head:"HTMLHeadElement",header:"HTMLElement",hgroup:"HTMLElement",hr:"HTMLHRElement",html:"HTMLHtmlElement",i:"HTMLElement",iframe:"HTMLIFrameElement",img:"HTMLImageElement",input:"HTMLInputElement",ins:"HTMLModElement",isindex:"HTMLUnknownElement",kbd:"HTMLElement",keygen:"HTMLKeygenElement",label:"HTMLLabelElement",legend:"HTMLLegendElement",li:"HTMLLIElement",link:"HTMLLinkElement",map:"HTMLMapElement",mark:"HTMLElement",menu:"HTMLMenuElement",meta:"HTMLMetaElement",meter:"HTMLMeterElement",nav:"HTMLElement",nobr:"HTMLElement",noembed:"HTMLElement",noframes:"HTMLElement",noscript:"HTMLElement",object:"HTMLObjectElement",ol:"HTMLOListElement",optgroup:"HTMLOptGroupElement",option:"HTMLOptionElement",output:"HTMLOutputElement",p:"HTMLParagraphElement",param:"HTMLParamElement",pre:"HTMLPreElement",progress:"HTMLProgressElement",q:"HTMLQuoteElement",s:"HTMLElement",samp:"HTMLElement",script:"HTMLScriptElement",section:"HTMLElement",select:"HTMLSelectElement",small:"HTMLElement",source:"HTMLSourceElement",span:"HTMLSpanElement",strike:"HTMLElement",strong:"HTMLElement",style:"HTMLStyleElement",sub:"HTMLElement",summary:"HTMLElement",sup:"HTMLElement",table:"HTMLTableElement",tbody:"HTMLTableSectionElement",td:"HTMLTableDataCellElement",textarea:"HTMLTextAreaElement",tfoot:"HTMLTableSectionElement",th:"HTMLTableHeaderCellElement",thead:"HTMLTableSectionElement",time:"HTMLTimeElement",title:"HTMLTitleElement",tr:"HTMLTableRowElement",track:"HTMLTrackElement",tt:"HTMLElement",u:"HTMLElement",ul:"HTMLUListElement","var":"HTMLElement",video:"HTMLVideoElement",wbr:"HTMLElement"};html4["ELEMENT_DOM_INTERFACES"]=html4.ELEMENT_DOM_INTERFACES;html4.ueffects={NOT_LOADED:0,SAME_DOCUMENT:1,NEW_DOCUMENT:2};html4["ueffects"]=html4.ueffects;html4.URIEFFECTS={"a::href":2,"area::href":2,"audio::src":1,"blockquote::cite":0,"command::icon":1,"del::cite":0,"form::action":2,"img::src":1,"input::src":1,"ins::cite":0,"q::cite":0,"video::poster":1,"video::src":1};html4["URIEFFECTS"]=html4.URIEFFECTS;html4.ltypes={UNSANDBOXED:2,SANDBOXED:1,DATA:0};html4["ltypes"]=html4.ltypes;html4.LOADERTYPES={"a::href":2,"area::href":2,"audio::src":2,"blockquote::cite":2,"command::icon":1,"del::cite":2,"form::action":2,"img::src":1,"input::src":1,"ins::cite":2,"q::cite":2,"video::poster":1,"video::src":2};html4["LOADERTYPES"]=html4.LOADERTYPES;if(typeof window!=="undefined"){window["html4"]=html4}if("I".toLowerCase()!=="i"){throw"I/i problem"}var html=function(html4){var parseCssDeclarations,sanitizeCssProperty,cssSchema;if("undefined"!==typeof window){parseCssDeclarations=window["parseCssDeclarations"];sanitizeCssProperty=window["sanitizeCssProperty"];cssSchema=window["cssSchema"]}var ENTITIES={lt:"<",LT:"<",gt:">",GT:">",amp:"&",AMP:"&",quot:'"',apos:"'",nbsp:" "};var decimalEscapeRe=/^#(\d+)$/;var hexEscapeRe=/^#x([0-9A-Fa-f]+)$/;var safeEntityNameRe=/^[A-Za-z][A-za-z0-9]+$/;var entityLookupElement="undefined"!==typeof window&&window["document"]?window["document"].createElement("textarea"):null;function lookupEntity(name){if(ENTITIES.hasOwnProperty(name)){return ENTITIES[name]}var m=name.match(decimalEscapeRe);if(m){return String.fromCharCode(parseInt(m[1],10))}else if(!!(m=name.match(hexEscapeRe))){return String.fromCharCode(parseInt(m[1],16))}else if(entityLookupElement&&safeEntityNameRe.test(name)){entityLookupElement.innerHTML="&"+name+";";var text=entityLookupElement.textContent;ENTITIES[name]=text;return text}else{return"&"+name+";"}}function decodeOneEntity(_,name){return lookupEntity(name)}var nulRe=/\0/g;function stripNULs(s){return s.replace(nulRe,"")}var ENTITY_RE_1=/&(#[0-9]+|#[xX][0-9A-Fa-f]+|\w+);/g;var ENTITY_RE_2=/^(#[0-9]+|#[xX][0-9A-Fa-f]+|\w+);/;function unescapeEntities(s){return s.replace(ENTITY_RE_1,decodeOneEntity)}var ampRe=/&/g;var looseAmpRe=/&([^a-z#]|#(?:[^0-9x]|x(?:[^0-9a-f]|$)|$)|$)/gi;var ltRe=/[<]/g;var gtRe=/>/g;var quotRe=/\"/g;function escapeAttrib(s){return(""+s).replace(ampRe,"&amp;").replace(ltRe,"&lt;").replace(gtRe,"&gt;").replace(quotRe,"&#34;")}function normalizeRCData(rcdata){return rcdata.replace(looseAmpRe,"&amp;$1").replace(ltRe,"&lt;").replace(gtRe,"&gt;")}var ATTR_RE=new RegExp("^\\s*"+"([-.:\\w]+)"+"(?:"+("\\s*(=)\\s*"+"("+('(")[^"]*("|$)'+"|"+"(')[^']*('|$)"+"|"+"(?=[a-z][-\\w]*\\s*=)"+"|"+"[^\"'\\s]*")+")")+")?","i");var splitWillCapture="a,b".split(/(,)/).length===3;var EFLAGS_TEXT=html4.eflags["CDATA"]|html4.eflags["RCDATA"];function makeSaxParser(handler){var hcopy={cdata:handler.cdata||handler["cdata"],comment:handler.comment||handler["comment"],endDoc:handler.endDoc||handler["endDoc"],endTag:handler.endTag||handler["endTag"],pcdata:handler.pcdata||handler["pcdata"],rcdata:handler.rcdata||handler["rcdata"],startDoc:handler.startDoc||handler["startDoc"],startTag:handler.startTag||handler["startTag"]};return function(htmlText,param){return parse(htmlText,hcopy,param)}}var continuationMarker={};function parse(htmlText,handler,param){var m,p,tagName;var parts=htmlSplit(htmlText);var state={noMoreGT:false,noMoreEndComments:false};parseCPS(handler,parts,0,state,param)}function continuationMaker(h,parts,initial,state,param){return function(){parseCPS(h,parts,initial,state,param)}}function parseCPS(h,parts,initial,state,param){try{if(h.startDoc&&initial==0){h.startDoc(param)}var m,p,tagName;for(var pos=initial,end=parts.length;pos<end;){var current=parts[pos++];var next=parts[pos];switch(current){case"&":if(ENTITY_RE_2.test(next)){if(h.pcdata){h.pcdata("&"+next,param,continuationMarker,continuationMaker(h,parts,pos,state,param))}pos++}else{if(h.pcdata){h.pcdata("&amp;",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}break;case"</":if(m=/^([-\w:]+)[^\'\"]*/.exec(next)){if(m[0].length===next.length&&parts[pos+1]===">"){pos+=2;tagName=m[1].toLowerCase();if(h.endTag){h.endTag(tagName,param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}else{pos=parseEndTag(parts,pos,h,param,continuationMarker,state)}}else{if(h.pcdata){h.pcdata("&lt;/",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}break;case"<":if(m=/^([-\w:]+)\s*\/?/.exec(next)){if(m[0].length===next.length&&parts[pos+1]===">"){pos+=2;tagName=m[1].toLowerCase();if(h.startTag){h.startTag(tagName,[],param,continuationMarker,continuationMaker(h,parts,pos,state,param))}var eflags=html4.ELEMENTS[tagName];if(eflags&EFLAGS_TEXT){var tag={name:tagName,next:pos,eflags:eflags};pos=parseText(parts,tag,h,param,continuationMarker,state)}}else{pos=parseStartTag(parts,pos,h,param,continuationMarker,state)}}else{if(h.pcdata){h.pcdata("&lt;",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}break;case"<!--":if(!state.noMoreEndComments){for(p=pos+1;p<end;p++){if(parts[p]===">"&&/--$/.test(parts[p-1])){break}}if(p<end){if(h.comment){var comment=parts.slice(pos,p).join("");h.comment(comment.substr(0,comment.length-2),param,continuationMarker,continuationMaker(h,parts,p+1,state,param))}pos=p+1}else{state.noMoreEndComments=true}}if(state.noMoreEndComments){if(h.pcdata){h.pcdata("&lt;!--",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}break;case"<!":if(!/^\w/.test(next)){if(h.pcdata){h.pcdata("&lt;!",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}else{if(!state.noMoreGT){for(p=pos+1;p<end;p++){if(parts[p]===">"){break}}if(p<end){pos=p+1}else{state.noMoreGT=true}}if(state.noMoreGT){if(h.pcdata){h.pcdata("&lt;!",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}}break;case"<?":if(!state.noMoreGT){for(p=pos+1;p<end;p++){if(parts[p]===">"){break}}if(p<end){pos=p+1}else{state.noMoreGT=true}}if(state.noMoreGT){if(h.pcdata){h.pcdata("&lt;?",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}}break;case">":if(h.pcdata){h.pcdata("&gt;",param,continuationMarker,continuationMaker(h,parts,pos,state,param))}break;case"":break;default:if(h.pcdata){h.pcdata(current,param,continuationMarker,continuationMaker(h,parts,pos,state,param))}break}}if(h.endDoc){h.endDoc(param)}}catch(e){if(e!==continuationMarker){throw e}}}function htmlSplit(str){var re=/(<\/|<\!--|<[!?]|[&<>])/g;str+="";if(splitWillCapture){return str.split(re)}else{var parts=[];var lastPos=0;var m;while((m=re.exec(str))!==null){parts.push(str.substring(lastPos,m.index));parts.push(m[0]);lastPos=m.index+m[0].length}parts.push(str.substring(lastPos));return parts}}function parseEndTag(parts,pos,h,param,continuationMarker,state){var tag=parseTagAndAttrs(parts,pos);if(!tag){return parts.length}if(h.endTag){h.endTag(tag.name,param,continuationMarker,continuationMaker(h,parts,pos,state,param))}return tag.next}function parseStartTag(parts,pos,h,param,continuationMarker,state){var tag=parseTagAndAttrs(parts,pos);if(!tag){return parts.length}if(h.startTag){h.startTag(tag.name,tag.attrs,param,continuationMarker,continuationMaker(h,parts,tag.next,state,param))}if(tag.eflags&EFLAGS_TEXT){return parseText(parts,tag,h,param,continuationMarker,state)}else{return tag.next}}var endTagRe={};function parseText(parts,tag,h,param,continuationMarker,state){var end=parts.length;if(!endTagRe.hasOwnProperty(tag.name)){endTagRe[tag.name]=new RegExp("^"+tag.name+"(?:[\\s\\/]|$)","i")}var re=endTagRe[tag.name];var first=tag.next;var p=tag.next+1;for(;p<end;p++){if(parts[p-1]==="</"&&re.test(parts[p])){break}}if(p<end){p-=1}var buf=parts.slice(first,p).join("");if(tag.eflags&html4.eflags["CDATA"]){if(h.cdata){h.cdata(buf,param,continuationMarker,continuationMaker(h,parts,p,state,param))}}else if(tag.eflags&html4.eflags["RCDATA"]){if(h.rcdata){h.rcdata(normalizeRCData(buf),param,continuationMarker,continuationMaker(h,parts,p,state,param))}}else{throw new Error("bug")}return p}function parseTagAndAttrs(parts,pos){var m=/^([-\w:]+)/.exec(parts[pos]);var tag={};tag.name=m[1].toLowerCase();tag.eflags=html4.ELEMENTS[tag.name];var buf=parts[pos].substr(m[0].length);var p=pos+1;var end=parts.length;for(;p<end;p++){if(parts[p]===">"){break}buf+=parts[p]}if(end<=p){return void 0}var attrs=[];while(buf!==""){m=ATTR_RE.exec(buf);if(!m){buf=buf.replace(/^[\s\S][^a-z\s]*/,"")}else if(m[4]&&!m[5]||m[6]&&!m[7]){var quote=m[4]||m[6];var sawQuote=false;var abuf=[buf,parts[p++]];for(;p<end;p++){if(sawQuote){if(parts[p]===">"){break}}else if(0<=parts[p].indexOf(quote)){sawQuote=true}abuf.push(parts[p])}if(end<=p){break}buf=abuf.join("");continue}else{var aName=m[1].toLowerCase();var aValue=m[2]?decodeValue(m[3]):"";attrs.push(aName,aValue);buf=buf.substr(m[0].length)}}tag.attrs=attrs;tag.next=p+1;return tag}function decodeValue(v){var q=v.charCodeAt(0);if(q===34||q===39){v=v.substr(1,v.length-2)}return unescapeEntities(stripNULs(v))}function makeHtmlSanitizer(tagPolicy){var stack;var ignoring;var emit=function(text,out){if(!ignoring){out.push(text)}};return makeSaxParser({startDoc:function(_){stack=[];ignoring=false},startTag:function(tagNameOrig,attribs,out){if(ignoring){return}if(!html4.ELEMENTS.hasOwnProperty(tagNameOrig)){return}var eflagsOrig=html4.ELEMENTS[tagNameOrig];if(eflagsOrig&html4.eflags["FOLDABLE"]){return}var decision=tagPolicy(tagNameOrig,attribs);if(!decision){ignoring=!(eflagsOrig&html4.eflags["EMPTY"]);
return}else if(typeof decision!=="object"){throw new Error("tagPolicy did not return object (old API?)")}if("attribs"in decision){attribs=decision["attribs"]}else{throw new Error("tagPolicy gave no attribs")}var eflagsRep;var tagNameRep;if("tagName"in decision){tagNameRep=decision["tagName"];eflagsRep=html4.ELEMENTS[tagNameRep]}else{tagNameRep=tagNameOrig;eflagsRep=eflagsOrig}if(eflagsOrig&html4.eflags["OPTIONAL_ENDTAG"]){var onStack=stack[stack.length-1];if(onStack&&onStack.orig===tagNameOrig&&(onStack.rep!==tagNameRep||tagNameOrig!==tagNameRep)){out.push("</",onStack.rep,">")}}if(!(eflagsOrig&html4.eflags["EMPTY"])){stack.push({orig:tagNameOrig,rep:tagNameRep})}out.push("<",tagNameRep);for(var i=0,n=attribs.length;i<n;i+=2){var attribName=attribs[i],value=attribs[i+1];if(value!==null&&value!==void 0){out.push(" ",attribName,'="',escapeAttrib(value),'"')}}out.push(">");if(eflagsOrig&html4.eflags["EMPTY"]&&!(eflagsRep&html4.eflags["EMPTY"])){out.push("</",tagNameRep,">")}},endTag:function(tagName,out){if(ignoring){ignoring=false;return}if(!html4.ELEMENTS.hasOwnProperty(tagName)){return}var eflags=html4.ELEMENTS[tagName];if(!(eflags&(html4.eflags["EMPTY"]|html4.eflags["FOLDABLE"]))){var index;if(eflags&html4.eflags["OPTIONAL_ENDTAG"]){for(index=stack.length;--index>=0;){var stackElOrigTag=stack[index].orig;if(stackElOrigTag===tagName){break}if(!(html4.ELEMENTS[stackElOrigTag]&html4.eflags["OPTIONAL_ENDTAG"])){return}}}else{for(index=stack.length;--index>=0;){if(stack[index].orig===tagName){break}}}if(index<0){return}for(var i=stack.length;--i>index;){var stackElRepTag=stack[i].rep;if(!(html4.ELEMENTS[stackElRepTag]&html4.eflags["OPTIONAL_ENDTAG"])){out.push("</",stackElRepTag,">")}}if(index<stack.length){tagName=stack[index].rep}stack.length=index;out.push("</",tagName,">")}},pcdata:emit,rcdata:emit,cdata:emit,endDoc:function(out){for(;stack.length;stack.length--){out.push("</",stack[stack.length-1].rep,">")}}})}var ALLOWED_URI_SCHEMES=/^(?:https?|mailto)$/i;function safeUri(uri,effect,ltype,hints,naiveUriRewriter){if(!naiveUriRewriter){return null}try{var parsed=URI.parse(""+uri);if(parsed){if(!parsed.hasScheme()||ALLOWED_URI_SCHEMES.test(parsed.getScheme())){var safe=naiveUriRewriter(parsed,effect,ltype,hints);return safe?safe.toString():null}}}catch(e){return null}return null}function log(logger,tagName,attribName,oldValue,newValue){if(!attribName){logger(tagName+" removed",{change:"removed",tagName:tagName})}if(oldValue!==newValue){var changed="changed";if(oldValue&&!newValue){changed="removed"}else if(!oldValue&&newValue){changed="added"}logger(tagName+"."+attribName+" "+changed,{change:changed,tagName:tagName,attribName:attribName,oldValue:oldValue,newValue:newValue})}}function lookupAttribute(map,tagName,attribName){var attribKey;attribKey=tagName+"::"+attribName;if(map.hasOwnProperty(attribKey)){return map[attribKey]}attribKey="*::"+attribName;if(map.hasOwnProperty(attribKey)){return map[attribKey]}return void 0}function getAttributeType(tagName,attribName){return lookupAttribute(html4.ATTRIBS,tagName,attribName)}function getLoaderType(tagName,attribName){return lookupAttribute(html4.LOADERTYPES,tagName,attribName)}function getUriEffect(tagName,attribName){return lookupAttribute(html4.URIEFFECTS,tagName,attribName)}function sanitizeAttribs(tagName,attribs,opt_naiveUriRewriter,opt_nmTokenPolicy,opt_logger){for(var i=0;i<attribs.length;i+=2){var attribName=attribs[i];var value=attribs[i+1];var oldValue=value;var atype=null,attribKey;if((attribKey=tagName+"::"+attribName,html4.ATTRIBS.hasOwnProperty(attribKey))||(attribKey="*::"+attribName,html4.ATTRIBS.hasOwnProperty(attribKey))){atype=html4.ATTRIBS[attribKey]}if(atype!==null){switch(atype){case html4.atype["NONE"]:break;case html4.atype["SCRIPT"]:value=null;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break;case html4.atype["STYLE"]:if("undefined"===typeof parseCssDeclarations){value=null;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break}var sanitizedDeclarations=[];parseCssDeclarations(value,{declaration:function(property,tokens){var normProp=property.toLowerCase();sanitizeCssProperty(normProp,tokens,opt_naiveUriRewriter?function(url){return safeUri(url,html4.ueffects.SAME_DOCUMENT,html4.ltypes.SANDBOXED,{TYPE:"CSS",CSS_PROP:normProp},opt_naiveUriRewriter)}:null);if(tokens.length){sanitizedDeclarations.push(normProp+": "+tokens.join(" "))}}});value=sanitizedDeclarations.length>0?sanitizedDeclarations.join(" ; "):null;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break;case html4.atype["ID"]:case html4.atype["IDREF"]:case html4.atype["IDREFS"]:case html4.atype["GLOBAL_NAME"]:case html4.atype["LOCAL_NAME"]:case html4.atype["CLASSES"]:value=opt_nmTokenPolicy?opt_nmTokenPolicy(value):value;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break;case html4.atype["URI"]:value=safeUri(value,getUriEffect(tagName,attribName),getLoaderType(tagName,attribName),{TYPE:"MARKUP",XML_ATTR:attribName,XML_TAG:tagName},opt_naiveUriRewriter);if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break;case html4.atype["URI_FRAGMENT"]:if(value&&"#"===value.charAt(0)){value=value.substring(1);value=opt_nmTokenPolicy?opt_nmTokenPolicy(value):value;if(value!==null&&value!==void 0){value="#"+value}}else{value=null}if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break;default:value=null;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}break}}else{value=null;if(opt_logger){log(opt_logger,tagName,attribName,oldValue,value)}}attribs[i+1]=value}return attribs}function makeTagPolicy(opt_naiveUriRewriter,opt_nmTokenPolicy,opt_logger){return function(tagName,attribs){if(!(html4.ELEMENTS[tagName]&html4.eflags["UNSAFE"])){return{attribs:sanitizeAttribs(tagName,attribs,opt_naiveUriRewriter,opt_nmTokenPolicy,opt_logger)}}else{if(opt_logger){log(opt_logger,tagName,undefined,undefined,undefined)}}}}function sanitizeWithPolicy(inputHtml,tagPolicy){var outputArray=[];makeHtmlSanitizer(tagPolicy)(inputHtml,outputArray);return outputArray.join("")}function sanitize(inputHtml,opt_naiveUriRewriter,opt_nmTokenPolicy,opt_logger){var tagPolicy=makeTagPolicy(opt_naiveUriRewriter,opt_nmTokenPolicy,opt_logger);return sanitizeWithPolicy(inputHtml,tagPolicy)}var html={};html.escapeAttrib=html["escapeAttrib"]=escapeAttrib;html.makeHtmlSanitizer=html["makeHtmlSanitizer"]=makeHtmlSanitizer;html.makeSaxParser=html["makeSaxParser"]=makeSaxParser;html.makeTagPolicy=html["makeTagPolicy"]=makeTagPolicy;html.normalizeRCData=html["normalizeRCData"]=normalizeRCData;html.sanitize=html["sanitize"]=sanitize;html.sanitizeAttribs=html["sanitizeAttribs"]=sanitizeAttribs;html.sanitizeWithPolicy=html["sanitizeWithPolicy"]=sanitizeWithPolicy;html.unescapeEntities=html["unescapeEntities"]=unescapeEntities;return html}(html4);var html_sanitize=html["sanitize"];if(typeof window!=="undefined"){window["html"]=html;window["html_sanitize"]=html_sanitize};

var baseJsSecurity = (function baseJsSecurity() {
    "use strict";

    var noop = function (x) { return x; };

    var caja;
    if (window && window.html) {
        caja = window.html;
        caja.html4 = window.html4;
        caja.sanitizeStylesheet = window.sanitizeStylesheet;
    }

    var sanitizeAttribs = function (tagName, attribs, opt_naiveUriRewriter, opt_nmTokenPolicy, opt_logger) {
        /**
         * add trusting data-attributes to the default sanitizeAttribs from caja
         * this function is mostly copied from the caja source
         */
        var ATTRIBS = caja.html4.ATTRIBS;
        for (var i = 0; i < attribs.length; i += 2) {
            var attribName = attribs[i];
            if (attribName.substr(0,5) == 'data-') {
                var attribKey = '*::' + attribName;
                if (!ATTRIBS.hasOwnProperty(attribKey)) {
                    ATTRIBS[attribKey] = 0;
                }
            }
        }
        return caja.sanitizeAttribs(tagName, attribs, opt_naiveUriRewriter, opt_nmTokenPolicy, opt_logger);
    };

    var sanitize_css = function (css, tagPolicy) {
        /**
         * sanitize CSS
         * like sanitize_html, but for CSS
         * called by sanitize_stylesheets
         */
        return caja.sanitizeStylesheet(
            window.location.pathname,
            css,
            {
                containerClass: null,
                idSuffix: '',
                tagPolicy: tagPolicy,
                virtualizeAttrName: noop
            },
            noop
        );
    };

    var sanitize_stylesheets = function (html, tagPolicy) {
        /**
         * sanitize just the css in style tags in a block of html
         * called by sanitize_html, if allow_css is true
         */
        var h = $("<div/>").append(html);
        var style_tags = h.find("style");
        if (!style_tags.length) {
            // no style tags to sanitize
            return html;
        }
        style_tags.each(function(i, style) {
            style.innerHTML = sanitize_css(style.innerHTML, tagPolicy);
        });
        return h.html();
    };

    var sanitize_html = function (html, allow_css) {
        /**
         * sanitize HTML
         * if allow_css is true (default: false), CSS is sanitized as well.
         * otherwise, CSS elements and attributes are simply removed.
         */
        var html4 = caja.html4;

        if (allow_css) {
            // allow sanitization of style tags,
            // not just scrubbing
            html4.ELEMENTS.style &= ~html4.eflags.UNSAFE;
            html4.ATTRIBS.style = html4.atype.STYLE;
        } else {
            // scrub all CSS
            html4.ELEMENTS.style |= html4.eflags.UNSAFE;
            html4.ATTRIBS.style = html4.atype.SCRIPT;
        }

        var record_messages = function (msg, opts) {
            //console.log("HTML Sanitizer", msg, opts);
        };

        var policy = function (tagName, attribs) {
            if (!(html4.ELEMENTS[tagName] & html4.eflags.UNSAFE)) {
                return {
                    'attribs': sanitizeAttribs(tagName, attribs,
                        noop, noop, record_messages)
                    };
            } else {
                record_messages(tagName + " removed", {
                  change: "removed",
                  tagName: tagName
                });
            }
        };

        var sanitized = caja.sanitizeWithPolicy(html, policy);

        if (allow_css) {
            // sanitize style tags as stylesheets
            sanitized = sanitize_stylesheets(result.sanitized, policy);
        }

        return sanitized;
    };

    var security = {
        caja: caja,
        sanitize_html: sanitize_html
    };

    return security;
})();

var serviceConfig = (function serviceConfig() {
    "use strict";
    var utils = baseJsUtils;

    var ConfigSection = function(section_name, options) {
        this.section_name = section_name;
        this.base_url = options.base_url;
        this.data = {};

        var that = this;

        /* .loaded is a promise, fulfilled the first time the config is loaded
         * from the server. Code can do:
         *      conf.loaded.then(function() { ... using conf.data ... });
         */
        this._one_load_finished = false;
        this.loaded = new Promise(function(resolve, reject) {
            that._finish_firstload = resolve;
        });
    };

    ConfigSection.prototype.api_url = function() {
        return utils.url_join_encode(this.base_url, 'api/config', this.section_name);
    };

    ConfigSection.prototype._load_done = function() {
        if (!this._one_load_finished) {
            this._one_load_finished = true;
            this._finish_firstload();
        }
    };

    ConfigSection.prototype.load = function() {
        var that = this;
        return utils.promising_ajax(this.api_url(), {
            cache: false,
            type: "GET",
            dataType: "json",
        }).then(function(data) {
            that.data = data;
            that._load_done();
            return data;
        });
    };

    /**
     * Modify the config values stored. Update the local data immediately,
     * send the change to the server, and use the updated data from the server
     * when the reply comes.
     */
    ConfigSection.prototype.update = function(newdata) {
        $.extend(true, this.data, newdata);  // true -> recursive update

        var that = this;
        return utils.promising_ajax(this.api_url(), {
            processData: false,
            type : "PATCH",
            data: JSON.stringify(newdata),
            dataType : "json",
            contentType: 'application/json',
        }).then(function(data) {
            that.data = data;
            that._load_done();
            return data;
        });
    };


    var ConfigWithDefaults = function(section, defaults, classname) {
        this.section = section;
        this.defaults = defaults;
        this.classname = classname;
    };

    ConfigWithDefaults.prototype._class_data = function() {
        if (this.classname) {
            return this.section.data[this.classname] || {};
        } else {
            return this.section.data
        }
    };

    /**
     * Wait for config to have loaded, then get a value or the default.
     * Returns a promise.
     */
    ConfigWithDefaults.prototype.get = function(key) {
        var that = this;
        return this.section.loaded.then(function() {
            return this._class_data()[key] || this.defaults[key]
        });
    };

    /**
     * Return a config value. If config is not yet loaded, return the default
     * instead of waiting for it to load.
     */
    ConfigWithDefaults.prototype.get_sync = function(key) {
        return this._class_data()[key] || this.defaults[key];
    };

    /**
     * Set a config value. Send the update to the server, and change our
     * local copy of the data immediately.
     * Returns a promise which is fulfilled when the server replies to the
     * change.
     */
     ConfigWithDefaults.prototype.set = function(key, value) {
         var d = {};
         d[key] = value;
         if (this.classname) {
            var d2 = {};
            d2[this.classname] = d;
            return this.section.update(d2);
        } else {
            return this.section.update(d);
        }
    };

    return {ConfigSection: ConfigSection,
            ConfigWithDefaults: ConfigWithDefaults,
           };

})();

var notebookJsMathjaxutils = (function notebookJsMathjaxutils() {
    "use strict";

    var utils = baseJsUtils;
    var dialog = baseJsDialog;

    // Some magic for deferring mathematical expressions to MathJax
    // by hiding them from the Markdown parser.
    // Some of the code here is adapted with permission from Davide Cervone
    // under the terms of the Apache2 license governing the MathJax project.
    // Other minor modifications are also due to StackExchange and are used with
    // permission.

    var inline = "$"; // the inline math delimiter

    // MATHSPLIT contains the pattern for math delimiters and special symbols
    // needed for searching for math in the text input.
    var MATHSPLIT = /(\$\$?|\\(?:begin|end)\{[a-z]*\*?\}|\\[\\{}$]|[{}]|(?:\n\s*)+|@@\d+@@)/i;

    //  The math is in blocks i through j, so
    //    collect it into one block and clear the others.
    //  Replace &, <, and > by named entities.
    //  For IE, put <br> at the ends of comments since IE removes \n.
    //  Clear the current math positions and store the index of the
    //    math, then push the math string onto the storage array.
    //  The preProcess function is called on all blocks if it has been passed in
    var process_math = function (i, j, pre_process, math, blocks) {
        var block = blocks.slice(i, j + 1).join("").replace(/&/g, "&amp;") // use HTML entity for &
        .replace(/</g, "&lt;") // use HTML entity for <
        .replace(/>/g, "&gt;") // use HTML entity for >
        ;
        if (utils.browser === 'msie') {
            block = block.replace(/(%[^\n]*)\n/g, "$1<br/>\n");
        }
        while (j > i) {
            blocks[j] = "";
            j--;
        }
        blocks[i] = "@@" + math.length + "@@"; // replace the current block text with a unique tag to find later
        if (pre_process){
            block = pre_process(block);
        }
        math.push(block);
        return blocks;
    };

    //  Break up the text into its component parts and search
    //    through them for math delimiters, braces, linebreaks, etc.
    //  Math delimiters must match and braces must balance.
    //  Don't allow math to pass through a double linebreak
    //    (which will be a paragraph).
    //
    var remove_math = function (text) {
        var math = []; // stores math strings for later
        var start;
        var end;
        var last;
        var braces;

        // Except for extreme edge cases, this should catch precisely those pieces of the markdown
        // source that will later be turned into code spans. While MathJax will not TeXify code spans,
        // we still have to consider them at this point; the following issue has happened several times:
        //
        //     `$foo` and `$bar` are varibales.  -->  <code>$foo ` and `$bar</code> are variables.

        var hasCodeSpans = /`/.test(text),
            de_tilde;
        if (hasCodeSpans) {
            text = text.replace(/~/g, "~T").replace(/(^|[^\\])(`+)([^\n]*?[^`\n])\2(?!`)/gm, function (wholematch) {
                return wholematch.replace(/\$/g, "~D");
            });
            de_tilde = function (text) {
                return text.replace(/~([TD])/g, function (wholematch, character) {
                                                    return { T: "~", D: "$" }[character];
                                                });
            };
        } else {
            de_tilde = function (text) { return text; };
        }

        var blocks = utils.regex_split(text.replace(/\r\n?/g, "\n"),MATHSPLIT);

        for (var i = 1, m = blocks.length; i < m; i += 2) {
            var block = blocks[i];
            if (block.charAt(0) === "@") {
                //
                //  Things that look like our math markers will get
                //  stored and then retrieved along with the math.
                //
                blocks[i] = "@@" + math.length + "@@";
                math.push(block);
            }
            else if (start) {
                //
                //  If we are in math, look for the end delimiter,
                //    but don't go past double line breaks, and
                //    and balance braces within the math.
                //
                if (block === end) {
                    if (braces) {
                        last = i;
                    }
                    else {
                        blocks = process_math(start, i, de_tilde, math, blocks);
                        start  = null;
                        end    = null;
                        last   = null;
                    }
                }
                else if (block.match(/\n.*\n/)) {
                    if (last) {
                        i = last;
                        blocks = process_math(start, i, de_tilde, math, blocks);
                    }
                    start = null;
                    end = null;
                    last = null;
                    braces = 0;
                }
                else if (block === "{") {
                    braces++;
                }
                else if (block === "}" && braces) {
                    braces--;
                }
            }
            else {
                //
                //  Look for math start delimiters and when
                //    found, set up the end delimiter.
                //
                if (block === inline || block === "$$") {
                    start = i;
                    end = block;
                    braces = 0;
                }
                else if (block.substr(1, 5) === "begin") {
                    start = i;
                    end = "\\end" + block.substr(6);
                    braces = 0;
                }
            }
        }
        if (last) {
            blocks = process_math(start, last, de_tilde, math, blocks);
            start  = null;
            end    = null;
            last   = null;
        }
        return [de_tilde(blocks.join("")), math];
    };

    //
    //  Put back the math strings that were saved,
    //    and clear the math array (no need to keep it around).
    //
    var replace_math = function (text, math) {
        text = text.replace(/@@(\d+)@@/g, function (match, n) {
            return math[n];
        });
        return text;
    };

    var mathjaxutils = {
        remove_math : remove_math,
        replace_math : replace_math
    };

    return mathjaxutils;
})();

var baseJsCelltoolbar = (function baseJsCelltoolbar() {
    "use strict";

    var events = baseJsEvent;

    var CellToolbar = function (options) {
        /**
         * Constructor
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          cell: Cell instance
         *          notebook: Notebook instance
         *
         *  TODO: This leaks, when cell are deleted
         *  There is still a reference to each celltoolbars.
         */
        CellToolbar._instances.push(this);
        this.notebook = options.notebook;
        this.cell = options.cell;
        this.create_element();
        this.rebuild();
        return this;
    };


    CellToolbar.prototype.create_element = function () {
        this.inner_element = $('<div/>').addClass('celltoolbar');
        this.element = $('<div/>').addClass('ctb_hideshow')
            .append(this.inner_element);
    };


    // The default css style for the outer celltoolbar div
    // (ctb_hideshow) is display: none.
    // To show the cell toolbar, *both* of the following conditions must be met:
    // - A parent container has class `ctb_global_show`
    // - The celltoolbar has the class `ctb_show`
    // This allows global show/hide, as well as per-cell show/hide.

    CellToolbar.global_hide = function () {
        $('body').removeClass('ctb_global_show');
    };


    CellToolbar.global_show = function () {
        $('body').addClass('ctb_global_show');
    };


    CellToolbar.prototype.hide = function () {
        this.element.removeClass('ctb_show');
    };


    CellToolbar.prototype.show = function () {
        this.element.addClass('ctb_show');
    };


    /**
     * Class variable that should contain a dict of all available callback
     * we need to think of wether or not we allow nested namespace
     * @property _callback_dict
     * @private
     * @static
     * @type Dict
     */
    CellToolbar._callback_dict = {};


    /**
     * Class variable that should contain the reverse order list of the button
     * to add to the toolbar of each cell
     * @property _ui_controls_list
     * @private
     * @static
     * @type List
     */
    CellToolbar._ui_controls_list = [];


    /**
     * Class variable that should contain the CellToolbar instances for each
     * cell of the notebook
     *
     * @private
     * @property _instances
     * @static
     * @type List
     */
    CellToolbar._instances = [];


    /**
     * keep a list of all the available presets for the toolbar
     * @private
     * @property _presets
     * @static
     * @type Dict
     */
    CellToolbar._presets = {};


    // this is by design not a prototype.
    /**
     * Register a callback to create an UI element in a cell toolbar.
     * @method register_callback
     * @param name {String} name to use to refer to the callback. It is advised to use a prefix with the name
     * for easier sorting and avoid collision
     * @param callback {function(div, cell)} callback that will be called to generate the ui element
     * @param [cell_types] {List_of_String|undefined} optional list of cell types. If present the UI element
     * will be added only to cells of types in the list.
     *
     *
     * The callback will receive the following element :
     *
     *    * a div in which to add element.
     *    * the cell it is responsible from
     *
     * @example
     *
     * Example that create callback for a button that toggle between `true` and `false` label,
     * with the metadata under the key 'foo' to reflect the status of the button.
     *
     *      // first param reference to a DOM div
     *      // second param reference to the cell.
     *      var toggle =  function(div, cell) {
     *          var button_container = $(div)
     *
     *          // let's create a button that show the  current value of the metadata
     *          var button = $('<div/>').button({label:String(cell.metadata.foo)});
     *
     *          // On click, change the metadata value and update the button label
     *          button.click(function(){
     *                      var v = cell.metadata.foo;
     *                      cell.metadata.foo = !v;
     *                      button.button("option", "label", String(!v));
     *                  })
     *
     *          // add the button to the DOM div.
     *          button_container.append(button);
     *      }
     *
     *      // now we register the callback under the name `foo` to give the
     *      // user the ability to use it later
     *      CellToolbar.register_callback('foo', toggle);
     */
    CellToolbar.register_callback = function(name, callback, cell_types) {
        // Overwrite if it already exists.
        CellToolbar._callback_dict[name] = cell_types ? {callback: callback, cell_types: cell_types} : callback;
    };


    /**
     * Register a preset of UI element in a cell toolbar.
     * Not supported Yet.
     * @method register_preset
     * @param name {String} name to use to refer to the preset. It is advised to use a prefix with the name
     * for easier sorting and avoid collision
     * @param  preset_list {List_of_String} reverse order of the button in the toolbar. Each String of the list
     *          should correspond to a name of a registerd callback.
     *
     * @private
     * @example
     *
     *      CellToolbar.register_callback('foo.c1', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c2', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c3', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c4', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c5', function(div, cell){...});
     *
     *      CellToolbar.register_preset('foo.foo_preset1', ['foo.c1', 'foo.c2', 'foo.c5'])
     *      CellToolbar.register_preset('foo.foo_preset2', ['foo.c4', 'foo.c5'])
     */
    CellToolbar.register_preset = function(name, preset_list, notebook) {
        CellToolbar._presets[name] = preset_list;
        events.trigger('preset_added.CellToolbar', {name: name});
        // When "register_callback" is called by a custom extension, it may be executed after notebook is loaded.
        // In that case, activate the preset if needed.
        if (notebook && notebook.metadata && notebook.metadata.celltoolbar === name){
            CellToolbar.activate_preset(name);
        }
    };

    /**
     * unregister the selected preset,
     *
     * return true if preset successfully unregistered
     * false otherwise
     *
     **/
    CellToolbar.unregister_preset = function(name){
        if(CellToolbar._presets[name]){
            delete CellToolbar._presets[name];
            events.trigger('unregistered_preset.CellToolbar', {name: name});
            return true
        }
        return false
    }


    /**
     * List the names of the presets that are currently registered.
     *
     * @method list_presets
     * @static
     */
    CellToolbar.list_presets = function() {
        var keys = [];
        for (var k in CellToolbar._presets) {
            keys.push(k);
        }
        return keys;
    };


    /**
     * Activate an UI preset from `register_preset`
     *
     * This does not update the selection UI.
     *
     * @method activate_preset
     * @param preset_name {String} string corresponding to the preset name
     *
     * @static
     * @private
     * @example
     *
     *      CellToolbar.activate_preset('foo.foo_preset1');
     */
    CellToolbar.activate_preset = function(preset_name){
        var preset = CellToolbar._presets[preset_name];

        if(preset !== undefined){
            CellToolbar._ui_controls_list = preset;
            CellToolbar.rebuild_all();
        }

        events.trigger('preset_activated.CellToolbar', {name: preset_name});
    };


    /**
     * This should be called on the class and not on a instance as it will trigger
     * rebuild of all the instances.
     * @method rebuild_all
     * @static
     *
     */
    CellToolbar.rebuild_all = function(){
        for(var i=0; i < CellToolbar._instances.length; i++){
            CellToolbar._instances[i].rebuild();
        }
    };

    /**
     * Rebuild all the button on the toolbar to update its state.
     * @method rebuild
     */
    CellToolbar.prototype.rebuild = function(){
        /**
         * strip evrything from the div
         * which is probably inner_element
         * or this.element.
         */
        this.inner_element.empty();
        this.ui_controls_list = [];

        var callbacks = CellToolbar._callback_dict;
        var preset = CellToolbar._ui_controls_list;
        // Yes we iterate on the class variable, not the instance one.
        for (var i=0; i < preset.length; i++) {
            var key = preset[i];
            var callback = callbacks[key];
            if (!callback) continue;

            if (typeof callback === 'object') {
                if (callback.cell_types.indexOf(this.cell.cell_type) === -1) continue;
                callback = callback.callback;
            }

            var local_div = $('<div/>').addClass('button_container');
            try {
                callback(local_div, this.cell, this);
                this.ui_controls_list.push(key);
            } catch (e) {
                console.log("Error in cell toolbar callback " + key, e);
                continue;
            }
            // only append if callback succeeded.
            this.inner_element.append(local_div);
        }

        // If there are no controls or the cell is a rendered TextCell hide the toolbar.
        if (!this.ui_controls_list.length) {
            this.hide();
        } else {
            this.show();
        }
    };


    CellToolbar.utils = {};


    /**
     * A utility function to generate bindings between a checkbox and cell/metadata
     * @method utils.checkbox_ui_generator
     * @static
     *
     * @param name {string} Label in front of the checkbox
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value.
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     * @example
     *
     * An exmple that bind the subkey `slideshow.isSectionStart` to a checkbox with a `New Slide` label
     *
     *     var newSlide = CellToolbar.utils.checkbox_ui_generator('New Slide',
     *          // setter
     *          function(cell, value){
     *              // we check that the slideshow namespace exist and create it if needed
     *              if (cell.metadata.slideshow == undefined){cell.metadata.slideshow = {}}
     *              // set the value
     *              cell.metadata.slideshow.isSectionStart = value
     *              },
     *          //geter
     *          function(cell){ var ns = cell.metadata.slideshow;
     *              // if the slideshow namespace does not exist return `undefined`
     *              // (will be interpreted as `false` by checkbox) otherwise
     *              // return the value
     *              return (ns == undefined)? undefined: ns.isSectionStart
     *              }
     *      );
     *
     *      CellToolbar.register_callback('newSlide', newSlide);
     *
     */
    CellToolbar.utils.checkbox_ui_generator = function(name, setter, getter){
        return function(div, cell, celltoolbar) {
            var button_container = $(div);

            var chkb = $('<input/>').attr('type', 'checkbox');
            var lbl = $('<label/>').append($('<span/>').text(name));
            lbl.append(chkb);
            chkb.attr("checked", getter(cell));

            chkb.click(function(){
                        var v = getter(cell);
                        setter(cell, !v);
                        chkb.attr("checked", !v);
            });
            button_container.append($('<span/>').append(lbl));
        };
    };


    /**
     * A utility function to generate bindings between a input field and cell/metadata
     * @method utils.input_ui_generator
     * @static
     *
     * @param name {string} Label in front of the input field
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value.
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     */
    CellToolbar.utils.input_ui_generator = function(name, setter, getter){
        return function(div, cell, celltoolbar) {
            var button_container = $(div);

            var text = $('<input/>').attr('type', 'text');
            var lbl = $('<label/>').append($('<span/>').text(name));
            lbl.append(text);
            text.attr("value", getter(cell));

            text.keyup(function(){
                setter(cell, text.val());
            });
            button_container.append($('<span/>').append(lbl));
            IPython.keyboard_manager.register_events(text);
        };
    };

    /**
     * A utility function to generate bindings between a dropdown list cell
     * @method utils.select_ui_generator
     * @static
     *
     * @param list_list {list_of_sublist} List of sublist of metadata value and name in the dropdown list.
     *        subslit shoud contain 2 element each, first a string that woul be displayed in the dropdown list,
     *        and second the corresponding value to  be passed to setter/return by getter. the corresponding value
     *        should not be "undefined" or behavior can be unexpected.
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value of the metadata.
     * @param [label=""] {String} optionnal label for the dropdown menu
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     * @example
     *
     *      var select_type = CellToolbar.utils.select_ui_generator([
     *              ["<None>"       , "None"      ],
     *              ["Header Slide" , "header_slide" ],
     *              ["Slide"        , "slide"        ],
     *              ["Fragment"     , "fragment"     ],
     *              ["Skip"         , "skip"         ],
     *              ],
     *              // setter
     *              function(cell, value){
     *                  // we check that the slideshow namespace exist and create it if needed
     *                  if (cell.metadata.slideshow == undefined){cell.metadata.slideshow = {}}
     *                  // set the value
     *                  cell.metadata.slideshow.slide_type = value
     *                  },
     *              //geter
     *              function(cell){ var ns = cell.metadata.slideshow;
     *                  // if the slideshow namespace does not exist return `undefined`
     *                  // (will be interpreted as `false` by checkbox) otherwise
     *                  // return the value
     *                  return (ns == undefined)? undefined: ns.slide_type
     *                  }
     *      CellToolbar.register_callback('slideshow.select', select_type);
     *
     */
    CellToolbar.utils.select_ui_generator = function(list_list, setter, getter, label) {
        label = label || "";
        return function(div, cell, celltoolbar) {
            var button_container = $(div);
            var lbl = $("<label/>").append($('<span/>').text(label));
            var select = $('<select/>');
            for(var i=0; i < list_list.length; i++){
                var opt = $('<option/>')
                    .attr('value', list_list[i][1])
                    .text(list_list[i][0]);
                select.append(opt);
            }
            select.val(getter(cell));
            select.change(function(){
                        setter(cell, select.val());
                    });
            button_container.append($('<span/>').append(lbl).append(select));
        };
    };

    // Backwards compatability.
    IPython.CellToolbar = CellToolbar;

    return {'CellToolbar': CellToolbar};
})();

/**
 * marked - a markdown parser
 * Copyright (c) 2011-2014, Christopher Jeffrey. (MIT Licensed)
 * https://github.com/chjj/marked
 */

;(function() {
  
  /**
   * Block-Level Grammar
   */
  
  var block = {
    newline: /^\n+/,
    code: /^( {4}[^\n]+\n*)+/,
    fences: noop,
    hr: /^( *[-*_]){3,} *(?:\n+|$)/,
    heading: /^ *(#{1,6}) *([^\n]+?) *#* *(?:\n+|$)/,
    nptable: noop,
    lheading: /^([^\n]+)\n *(=|-){2,} *(?:\n+|$)/,
    blockquote: /^( *>[^\n]+(\n(?!def)[^\n]+)*\n*)+/,
    list: /^( *)(bull) [\s\S]+?(?:hr|def|\n{2,}(?! )(?!\1bull )\n*|\s*$)/,
    html: /^ *(?:comment *(?:\n|\s*$)|closed *(?:\n{2,}|\s*$)|closing *(?:\n{2,}|\s*$))/,
    def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +["(]([^\n]+)[")])? *(?:\n+|$)/,
    table: noop,
    paragraph: /^((?:[^\n]+\n?(?!hr|heading|lheading|blockquote|tag|def))+)\n*/,
    text: /^[^\n]+/
  };
  
  block.bullet = /(?:[*+-]|\d+\.)/;
  block.item = /^( *)(bull) [^\n]*(?:\n(?!\1bull )[^\n]*)*/;
  block.item = replace(block.item, 'gm')
    (/bull/g, block.bullet)
    ();
  
  block.list = replace(block.list)
    (/bull/g, block.bullet)
    ('hr', '\\n+(?=\\1?(?:[-*_] *){3,}(?:\\n+|$))')
    ('def', '\\n+(?=' + block.def.source + ')')
    ();
  
  block.blockquote = replace(block.blockquote)
    ('def', block.def)
    ();
  
  block._tag = '(?!(?:'
    + 'a|em|strong|small|s|cite|q|dfn|abbr|data|time|code'
    + '|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo'
    + '|span|br|wbr|ins|del|img)\\b)\\w+(?!:/|[^\\w\\s@]*@)\\b';
  
  block.html = replace(block.html)
    ('comment', /<!--[\s\S]*?-->/)
    ('closed', /<(tag)[\s\S]+?<\/\1>/)
    ('closing', /<tag(?:"[^"]*"|'[^']*'|[^'">])*?>/)
    (/tag/g, block._tag)
    ();
  
  block.paragraph = replace(block.paragraph)
    ('hr', block.hr)
    ('heading', block.heading)
    ('lheading', block.lheading)
    ('blockquote', block.blockquote)
    ('tag', '<' + block._tag)
    ('def', block.def)
    ();
  
  /**
   * Normal Block Grammar
   */
  
  block.normal = merge({}, block);
  
  /**
   * GFM Block Grammar
   */
  
  block.gfm = merge({}, block.normal, {
    fences: /^ *(`{3,}|~{3,})[ \.]*(\S+)? *\n([\s\S]+?)\s*\1 *(?:\n+|$)/,
    paragraph: /^/,
    heading: /^ *(#{1,6}) +([^\n]+?) *#* *(?:\n+|$)/
  });
  
  block.gfm.paragraph = replace(block.paragraph)
    ('(?!', '(?!'
      + block.gfm.fences.source.replace('\\1', '\\2') + '|'
      + block.list.source.replace('\\1', '\\3') + '|')
    ();
  
  /**
   * GFM + Tables Block Grammar
   */
  
  block.tables = merge({}, block.gfm, {
    nptable: /^ *(\S.*\|.*)\n *([-:]+ *\|[-| :]*)\n((?:.*\|.*(?:\n|$))*)\n*/,
    table: /^ *\|(.+)\n *\|( *[-:]+[-| :]*)\n((?: *\|.*(?:\n|$))*)\n*/
  });
  
  /**
   * Block Lexer
   */
  
  function Lexer(options) {
    this.tokens = [];
    this.tokens.links = {};
    this.options = options || marked.defaults;
    this.rules = block.normal;
  
    if (this.options.gfm) {
      if (this.options.tables) {
        this.rules = block.tables;
      } else {
        this.rules = block.gfm;
      }
    }
  }
  
  /**
   * Expose Block Rules
   */
  
  Lexer.rules = block;
  
  /**
   * Static Lex Method
   */
  
  Lexer.lex = function(src, options) {
    var lexer = new Lexer(options);
    return lexer.lex(src);
  };
  
  /**
   * Preprocessing
   */
  
  Lexer.prototype.lex = function(src) {
    src = src
      .replace(/\r\n|\r/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2424/g, '\n');
  
    return this.token(src, true);
  };
  
  /**
   * Lexing
   */
  
  Lexer.prototype.token = function(src, top, bq) {
    var src = src.replace(/^ +$/gm, '')
      , next
      , loose
      , cap
      , bull
      , b
      , item
      , space
      , i
      , l;
  
    while (src) {
      // newline
      if (cap = this.rules.newline.exec(src)) {
        src = src.substring(cap[0].length);
        if (cap[0].length > 1) {
          this.tokens.push({
            type: 'space'
          });
        }
      }
  
      // code
      if (cap = this.rules.code.exec(src)) {
        src = src.substring(cap[0].length);
        cap = cap[0].replace(/^ {4}/gm, '');
        this.tokens.push({
          type: 'code',
          text: !this.options.pedantic
            ? cap.replace(/\n+$/, '')
            : cap
        });
        continue;
      }
  
      // fences (gfm)
      if (cap = this.rules.fences.exec(src)) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'code',
          lang: cap[2],
          text: cap[3]
        });
        continue;
      }
  
      // heading
      if (cap = this.rules.heading.exec(src)) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'heading',
          depth: cap[1].length,
          text: cap[2]
        });
        continue;
      }
  
      // table no leading pipe (gfm)
      if (top && (cap = this.rules.nptable.exec(src))) {
        src = src.substring(cap[0].length);
  
        item = {
          type: 'table',
          header: cap[1].replace(/^ *| *\| *$/g, '').split(/ *\| */),
          align: cap[2].replace(/^ *|\| *$/g, '').split(/ *\| */),
          cells: cap[3].replace(/\n$/, '').split('\n')
        };
  
        for (i = 0; i < item.align.length; i++) {
          if (/^ *-+: *$/.test(item.align[i])) {
            item.align[i] = 'right';
          } else if (/^ *:-+: *$/.test(item.align[i])) {
            item.align[i] = 'center';
          } else if (/^ *:-+ *$/.test(item.align[i])) {
            item.align[i] = 'left';
          } else {
            item.align[i] = null;
          }
        }
  
        for (i = 0; i < item.cells.length; i++) {
          item.cells[i] = item.cells[i].split(/ *\| */);
        }
  
        this.tokens.push(item);
  
        continue;
      }
  
      // lheading
      if (cap = this.rules.lheading.exec(src)) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'heading',
          depth: cap[2] === '=' ? 1 : 2,
          text: cap[1]
        });
        continue;
      }
  
      // hr
      if (cap = this.rules.hr.exec(src)) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'hr'
        });
        continue;
      }
  
      // blockquote
      if (cap = this.rules.blockquote.exec(src)) {
        src = src.substring(cap[0].length);
  
        this.tokens.push({
          type: 'blockquote_start'
        });
  
        cap = cap[0].replace(/^ *> ?/gm, '');
  
        // Pass `top` to keep the current
        // "toplevel" state. This is exactly
        // how markdown.pl works.
        this.token(cap, top, true);
  
        this.tokens.push({
          type: 'blockquote_end'
        });
  
        continue;
      }
  
      // list
      if (cap = this.rules.list.exec(src)) {
        src = src.substring(cap[0].length);
        bull = cap[2];
  
        this.tokens.push({
          type: 'list_start',
          ordered: bull.length > 1
        });
  
        // Get each top-level item.
        cap = cap[0].match(this.rules.item);
  
        next = false;
        l = cap.length;
        i = 0;
  
        for (; i < l; i++) {
          item = cap[i];
  
          // Remove the list item's bullet
          // so it is seen as the next token.
          space = item.length;
          item = item.replace(/^ *([*+-]|\d+\.) +/, '');
  
          // Outdent whatever the
          // list item contains. Hacky.
          if (~item.indexOf('\n ')) {
            space -= item.length;
            item = !this.options.pedantic
              ? item.replace(new RegExp('^ {1,' + space + '}', 'gm'), '')
              : item.replace(/^ {1,4}/gm, '');
          }
  
          // Determine whether the next list item belongs here.
          // Backpedal if it does not belong in this list.
          if (this.options.smartLists && i !== l - 1) {
            b = block.bullet.exec(cap[i + 1])[0];
            if (bull !== b && !(bull.length > 1 && b.length > 1)) {
              src = cap.slice(i + 1).join('\n') + src;
              i = l - 1;
            }
          }
  
          // Determine whether item is loose or not.
          // Use: /(^|\n)(?! )[^\n]+\n\n(?!\s*$)/
          // for discount behavior.
          loose = next || /\n\n(?!\s*$)/.test(item);
          if (i !== l - 1) {
            next = item.charAt(item.length - 1) === '\n';
            if (!loose) loose = next;
          }
  
          this.tokens.push({
            type: loose
              ? 'loose_item_start'
              : 'list_item_start'
          });
  
          // Recurse.
          this.token(item, false, bq);
  
          this.tokens.push({
            type: 'list_item_end'
          });
        }
  
        this.tokens.push({
          type: 'list_end'
        });
  
        continue;
      }
  
      // html
      if (cap = this.rules.html.exec(src)) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: this.options.sanitize
            ? 'paragraph'
            : 'html',
          pre: !this.options.sanitizer
            && (cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style'),
          text: cap[0]
        });
        continue;
      }
  
      // def
      if ((!bq && top) && (cap = this.rules.def.exec(src))) {
        src = src.substring(cap[0].length);
        this.tokens.links[cap[1].toLowerCase()] = {
          href: cap[2],
          title: cap[3]
        };
        continue;
      }
  
      // table (gfm)
      if (top && (cap = this.rules.table.exec(src))) {
        src = src.substring(cap[0].length);
  
        item = {
          type: 'table',
          header: cap[1].replace(/^ *| *\| *$/g, '').split(/ *\| */),
          align: cap[2].replace(/^ *|\| *$/g, '').split(/ *\| */),
          cells: cap[3].replace(/(?: *\| *)?\n$/, '').split('\n')
        };
  
        for (i = 0; i < item.align.length; i++) {
          if (/^ *-+: *$/.test(item.align[i])) {
            item.align[i] = 'right';
          } else if (/^ *:-+: *$/.test(item.align[i])) {
            item.align[i] = 'center';
          } else if (/^ *:-+ *$/.test(item.align[i])) {
            item.align[i] = 'left';
          } else {
            item.align[i] = null;
          }
        }
  
        for (i = 0; i < item.cells.length; i++) {
          item.cells[i] = item.cells[i]
            .replace(/^ *\| *| *\| *$/g, '')
            .split(/ *\| */);
        }
  
        this.tokens.push(item);
  
        continue;
      }
  
      // top-level paragraph
      if (top && (cap = this.rules.paragraph.exec(src))) {
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'paragraph',
          text: cap[1].charAt(cap[1].length - 1) === '\n'
            ? cap[1].slice(0, -1)
            : cap[1]
        });
        continue;
      }
  
      // text
      if (cap = this.rules.text.exec(src)) {
        // Top-level should never reach here.
        src = src.substring(cap[0].length);
        this.tokens.push({
          type: 'text',
          text: cap[0]
        });
        continue;
      }
  
      if (src) {
        throw new
          Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
    }
  
    return this.tokens;
  };
  
  /**
   * Inline-Level Grammar
   */
  
  var inline = {
    escape: /^\\([\\`*{}\[\]()#+\-.!_>])/,
    autolink: /^<([^ >]+(@|:\/)[^ >]+)>/,
    url: noop,
    tag: /^<!--[\s\S]*?-->|^<\/?\w+(?:"[^"]*"|'[^']*'|[^'">])*?>/,
    link: /^!?\[(inside)\]\(href\)/,
    reflink: /^!?\[(inside)\]\s*\[([^\]]*)\]/,
    nolink: /^!?\[((?:\[[^\]]*\]|[^\[\]])*)\]/,
    strong: /^__([\s\S]+?)__(?!_)|^\*\*([\s\S]+?)\*\*(?!\*)/,
    em: /^\b_((?:[^_]|__)+?)_\b|^\*((?:\*\*|[\s\S])+?)\*(?!\*)/,
    code: /^(`+)\s*([\s\S]*?[^`])\s*\1(?!`)/,
    br: /^ {2,}\n(?!\s*$)/,
    del: noop,
    text: /^[\s\S]+?(?=[\\<!\[_*`]| {2,}\n|$)/
  };
  
  inline._inside = /(?:\[[^\]]*\]|[^\[\]]|\](?=[^\[]*\]))*/;
  inline._href = /\s*<?([\s\S]*?)>?(?:\s+['"]([\s\S]*?)['"])?\s*/;
  
  inline.link = replace(inline.link)
    ('inside', inline._inside)
    ('href', inline._href)
    ();
  
  inline.reflink = replace(inline.reflink)
    ('inside', inline._inside)
    ();
  
  /**
   * Normal Inline Grammar
   */
  
  inline.normal = merge({}, inline);
  
  /**
   * Pedantic Inline Grammar
   */
  
  inline.pedantic = merge({}, inline.normal, {
    strong: /^__(?=\S)([\s\S]*?\S)__(?!_)|^\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/,
    em: /^_(?=\S)([\s\S]*?\S)_(?!_)|^\*(?=\S)([\s\S]*?\S)\*(?!\*)/
  });
  
  /**
   * GFM Inline Grammar
   */
  
  inline.gfm = merge({}, inline.normal, {
    escape: replace(inline.escape)('])', '~|])')(),
    url: /^(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/,
    del: /^~~(?=\S)([\s\S]*?\S)~~/,
    text: replace(inline.text)
      (']|', '~]|')
      ('|', '|https?://|')
      ()
  });
  
  /**
   * GFM + Line Breaks Inline Grammar
   */
  
  inline.breaks = merge({}, inline.gfm, {
    br: replace(inline.br)('{2,}', '*')(),
    text: replace(inline.gfm.text)('{2,}', '*')()
  });
  
  /**
   * Inline Lexer & Compiler
   */
  
  function InlineLexer(links, options) {
    this.options = options || marked.defaults;
    this.links = links;
    this.rules = inline.normal;
    this.renderer = this.options.renderer || new Renderer;
    this.renderer.options = this.options;
  
    if (!this.links) {
      throw new
        Error('Tokens array requires a `links` property.');
    }
  
    if (this.options.gfm) {
      if (this.options.breaks) {
        this.rules = inline.breaks;
      } else {
        this.rules = inline.gfm;
      }
    } else if (this.options.pedantic) {
      this.rules = inline.pedantic;
    }
  }
  
  /**
   * Expose Inline Rules
   */
  
  InlineLexer.rules = inline;
  
  /**
   * Static Lexing/Compiling Method
   */
  
  InlineLexer.output = function(src, links, options) {
    var inline = new InlineLexer(links, options);
    return inline.output(src);
  };
  
  /**
   * Lexing/Compiling
   */
  
  InlineLexer.prototype.output = function(src) {
    var out = ''
      , link
      , text
      , href
      , cap;
  
    while (src) {
      // escape
      if (cap = this.rules.escape.exec(src)) {
        src = src.substring(cap[0].length);
        out += cap[1];
        continue;
      }
  
      // autolink
      if (cap = this.rules.autolink.exec(src)) {
        src = src.substring(cap[0].length);
        if (cap[2] === '@') {
          text = cap[1].charAt(6) === ':'
            ? this.mangle(cap[1].substring(7))
            : this.mangle(cap[1]);
          href = this.mangle('mailto:') + text;
        } else {
          text = escape(cap[1]);
          href = text;
        }
        out += this.renderer.link(href, null, text);
        continue;
      }
  
      // url (gfm)
      if (!this.inLink && (cap = this.rules.url.exec(src))) {
        src = src.substring(cap[0].length);
        text = escape(cap[1]);
        href = text;
        out += this.renderer.link(href, null, text);
        continue;
      }
  
      // tag
      if (cap = this.rules.tag.exec(src)) {
        if (!this.inLink && /^<a /i.test(cap[0])) {
          this.inLink = true;
        } else if (this.inLink && /^<\/a>/i.test(cap[0])) {
          this.inLink = false;
        }
        src = src.substring(cap[0].length);
        out += this.options.sanitize
          ? this.options.sanitizer
            ? this.options.sanitizer(cap[0])
            : escape(cap[0])
          : cap[0]
        continue;
      }
  
      // link
      if (cap = this.rules.link.exec(src)) {
        src = src.substring(cap[0].length);
        this.inLink = true;
        out += this.outputLink(cap, {
          href: cap[2],
          title: cap[3]
        });
        this.inLink = false;
        continue;
      }
  
      // reflink, nolink
      if ((cap = this.rules.reflink.exec(src))
          || (cap = this.rules.nolink.exec(src))) {
        src = src.substring(cap[0].length);
        link = (cap[2] || cap[1]).replace(/\s+/g, ' ');
        link = this.links[link.toLowerCase()];
        if (!link || !link.href) {
          out += cap[0].charAt(0);
          src = cap[0].substring(1) + src;
          continue;
        }
        this.inLink = true;
        out += this.outputLink(cap, link);
        this.inLink = false;
        continue;
      }
  
      // strong
      if (cap = this.rules.strong.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.strong(this.output(cap[2] || cap[1]));
        continue;
      }
  
      // em
      if (cap = this.rules.em.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.em(this.output(cap[2] || cap[1]));
        continue;
      }
  
      // code
      if (cap = this.rules.code.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.codespan(escape(cap[2], true));
        continue;
      }
  
      // br
      if (cap = this.rules.br.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.br();
        continue;
      }
  
      // del (gfm)
      if (cap = this.rules.del.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.del(this.output(cap[1]));
        continue;
      }
  
      // text
      if (cap = this.rules.text.exec(src)) {
        src = src.substring(cap[0].length);
        out += this.renderer.text(escape(this.smartypants(cap[0])));
        continue;
      }
  
      if (src) {
        throw new
          Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
    }
  
    return out;
  };
  
  /**
   * Compile Link
   */
  
  InlineLexer.prototype.outputLink = function(cap, link) {
    var href = escape(link.href)
      , title = link.title ? escape(link.title) : null;
  
    return cap[0].charAt(0) !== '!'
      ? this.renderer.link(href, title, this.output(cap[1]))
      : this.renderer.image(href, title, escape(cap[1]));
  };
  
  /**
   * Smartypants Transformations
   */
  
  InlineLexer.prototype.smartypants = function(text) {
    if (!this.options.smartypants) return text;
    return text
      // em-dashes
      .replace(/---/g, '\u2014')
      // en-dashes
      .replace(/--/g, '\u2013')
      // opening singles
      .replace(/(^|[-\u2014/(\[{"\s])'/g, '$1\u2018')
      // closing singles & apostrophes
      .replace(/'/g, '\u2019')
      // opening doubles
      .replace(/(^|[-\u2014/(\[{\u2018\s])"/g, '$1\u201c')
      // closing doubles
      .replace(/"/g, '\u201d')
      // ellipses
      .replace(/\.{3}/g, '\u2026');
  };
  
  /**
   * Mangle Links
   */
  
  InlineLexer.prototype.mangle = function(text) {
    if (!this.options.mangle) return text;
    var out = ''
      , l = text.length
      , i = 0
      , ch;
  
    for (; i < l; i++) {
      ch = text.charCodeAt(i);
      if (Math.random() > 0.5) {
        ch = 'x' + ch.toString(16);
      }
      out += '&#' + ch + ';';
    }
  
    return out;
  };
  
  /**
   * Renderer
   */
  
  function Renderer(options) {
    this.options = options || {};
  }
  
  Renderer.prototype.code = function(code, lang, escaped) {
    if (this.options.highlight) {
      var out = this.options.highlight(code, lang);
      if (out != null && out !== code) {
        escaped = true;
        code = out;
      }
    }
  
    if (!lang) {
      return '<pre><code>'
        + (escaped ? code : escape(code, true))
        + '\n</code></pre>';
    }
  
    return '<pre><code class="'
      + this.options.langPrefix
      + escape(lang, true)
      + '">'
      + (escaped ? code : escape(code, true))
      + '\n</code></pre>\n';
  };
  
  Renderer.prototype.blockquote = function(quote) {
    return '<blockquote>\n' + quote + '</blockquote>\n';
  };
  
  Renderer.prototype.html = function(html) {
    return html;
  };
  
  Renderer.prototype.heading = function(text, level, raw) {
    return '<h'
      + level
      + ' id="'
      + this.options.headerPrefix
      + raw.toLowerCase().replace(/[^\w]+/g, '-')
      + '">'
      + text
      + '</h'
      + level
      + '>\n';
  };
  
  Renderer.prototype.hr = function() {
    return this.options.xhtml ? '<hr/>\n' : '<hr>\n';
  };
  
  Renderer.prototype.list = function(body, ordered) {
    var type = ordered ? 'ol' : 'ul';
    return '<' + type + '>\n' + body + '</' + type + '>\n';
  };
  
  Renderer.prototype.listitem = function(text) {
    return '<li>' + text + '</li>\n';
  };
  
  Renderer.prototype.paragraph = function(text) {
    return '<p>' + text + '</p>\n';
  };
  
  Renderer.prototype.table = function(header, body) {
    return '<table>\n'
      + '<thead>\n'
      + header
      + '</thead>\n'
      + '<tbody>\n'
      + body
      + '</tbody>\n'
      + '</table>\n';
  };
  
  Renderer.prototype.tablerow = function(content) {
    return '<tr>\n' + content + '</tr>\n';
  };
  
  Renderer.prototype.tablecell = function(content, flags) {
    var type = flags.header ? 'th' : 'td';
    var tag = flags.align
      ? '<' + type + ' style="text-align:' + flags.align + '">'
      : '<' + type + '>';
    return tag + content + '</' + type + '>\n';
  };
  
  // span level renderer
  Renderer.prototype.strong = function(text) {
    return '<strong>' + text + '</strong>';
  };
  
  Renderer.prototype.em = function(text) {
    return '<em>' + text + '</em>';
  };
  
  Renderer.prototype.codespan = function(text) {
    return '<code>' + text + '</code>';
  };
  
  Renderer.prototype.br = function() {
    return this.options.xhtml ? '<br/>' : '<br>';
  };
  
  Renderer.prototype.del = function(text) {
    return '<del>' + text + '</del>';
  };
  
  Renderer.prototype.link = function(href, title, text) {
    if (this.options.sanitize) {
      try {
        var prot = decodeURIComponent(unescape(href))
          .replace(/[^\w:]/g, '')
          .toLowerCase();
      } catch (e) {
        return '';
      }
      if (prot.indexOf('javascript:') === 0 || prot.indexOf('vbscript:') === 0) {
        return '';
      }
    }
    var out = '<a href="' + href + '"';
    if (title) {
      out += ' title="' + title + '"';
    }
    out += '>' + text + '</a>';
    return out;
  };
  
  Renderer.prototype.image = function(href, title, text) {
    var out = '<img src="' + href + '" alt="' + text + '"';
    if (title) {
      out += ' title="' + title + '"';
    }
    out += this.options.xhtml ? '/>' : '>';
    return out;
  };
  
  Renderer.prototype.text = function(text) {
    return text;
  };
  
  /**
   * Parsing & Compiling
   */
  
  function Parser(options) {
    this.tokens = [];
    this.token = null;
    this.options = options || marked.defaults;
    this.options.renderer = this.options.renderer || new Renderer;
    this.renderer = this.options.renderer;
    this.renderer.options = this.options;
  }
  
  /**
   * Static Parse Method
   */
  
  Parser.parse = function(src, options, renderer) {
    var parser = new Parser(options, renderer);
    return parser.parse(src);
  };
  
  /**
   * Parse Loop
   */
  
  Parser.prototype.parse = function(src) {
    this.inline = new InlineLexer(src.links, this.options, this.renderer);
    this.tokens = src.reverse();
  
    var out = '';
    while (this.next()) {
      out += this.tok();
    }
  
    return out;
  };
  
  /**
   * Next Token
   */
  
  Parser.prototype.next = function() {
    return this.token = this.tokens.pop();
  };
  
  /**
   * Preview Next Token
   */
  
  Parser.prototype.peek = function() {
    return this.tokens[this.tokens.length - 1] || 0;
  };
  
  /**
   * Parse Text Tokens
   */
  
  Parser.prototype.parseText = function() {
    var body = this.token.text;
  
    while (this.peek().type === 'text') {
      body += '\n' + this.next().text;
    }
  
    return this.inline.output(body);
  };
  
  /**
   * Parse Current Token
   */
  
  Parser.prototype.tok = function() {
    switch (this.token.type) {
      case 'space': {
        return '';
      }
      case 'hr': {
        return this.renderer.hr();
      }
      case 'heading': {
        return this.renderer.heading(
          this.inline.output(this.token.text),
          this.token.depth,
          this.token.text);
      }
      case 'code': {
        return this.renderer.code(this.token.text,
          this.token.lang,
          this.token.escaped);
      }
      case 'table': {
        var header = ''
          , body = ''
          , i
          , row
          , cell
          , flags
          , j;
  
        // header
        cell = '';
        for (i = 0; i < this.token.header.length; i++) {
          flags = { header: true, align: this.token.align[i] };
          cell += this.renderer.tablecell(
            this.inline.output(this.token.header[i]),
            { header: true, align: this.token.align[i] }
          );
        }
        header += this.renderer.tablerow(cell);
  
        for (i = 0; i < this.token.cells.length; i++) {
          row = this.token.cells[i];
  
          cell = '';
          for (j = 0; j < row.length; j++) {
            cell += this.renderer.tablecell(
              this.inline.output(row[j]),
              { header: false, align: this.token.align[j] }
            );
          }
  
          body += this.renderer.tablerow(cell);
        }
        return this.renderer.table(header, body);
      }
      case 'blockquote_start': {
        var body = '';
  
        while (this.next().type !== 'blockquote_end') {
          body += this.tok();
        }
  
        return this.renderer.blockquote(body);
      }
      case 'list_start': {
        var body = ''
          , ordered = this.token.ordered;
  
        while (this.next().type !== 'list_end') {
          body += this.tok();
        }
  
        return this.renderer.list(body, ordered);
      }
      case 'list_item_start': {
        var body = '';
  
        while (this.next().type !== 'list_item_end') {
          body += this.token.type === 'text'
            ? this.parseText()
            : this.tok();
        }
  
        return this.renderer.listitem(body);
      }
      case 'loose_item_start': {
        var body = '';
  
        while (this.next().type !== 'list_item_end') {
          body += this.tok();
        }
  
        return this.renderer.listitem(body);
      }
      case 'html': {
        var html = !this.token.pre && !this.options.pedantic
          ? this.inline.output(this.token.text)
          : this.token.text;
        return this.renderer.html(html);
      }
      case 'paragraph': {
        return this.renderer.paragraph(this.inline.output(this.token.text));
      }
      case 'text': {
        return this.renderer.paragraph(this.parseText());
      }
    }
  };
  
  /**
   * Helpers
   */
  
  function escape(html, encode) {
    return html
      .replace(!encode ? /&(?!#?\w+;)/g : /&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  function unescape(html) {
    return html.replace(/&([#\w]+);/g, function(_, n) {
      n = n.toLowerCase();
      if (n === 'colon') return ':';
      if (n.charAt(0) === '#') {
        return n.charAt(1) === 'x'
          ? String.fromCharCode(parseInt(n.substring(2), 16))
          : String.fromCharCode(+n.substring(1));
      }
      return '';
    });
  }
  
  function replace(regex, opt) {
    regex = regex.source;
    opt = opt || '';
    return function self(name, val) {
      if (!name) return new RegExp(regex, opt);
      val = val.source || val;
      val = val.replace(/(^|[^\[])\^/g, '$1');
      regex = regex.replace(name, val);
      return self;
    };
  }
  
  function noop() {}
  noop.exec = noop;
  
  function merge(obj) {
    var i = 1
      , target
      , key;
  
    for (; i < arguments.length; i++) {
      target = arguments[i];
      for (key in target) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          obj[key] = target[key];
        }
      }
    }
  
    return obj;
  }
  
  
  /**
   * Marked
   */
  
  function marked(src, opt, callback) {
    if (callback || typeof opt === 'function') {
      if (!callback) {
        callback = opt;
        opt = null;
      }
  
      opt = merge({}, marked.defaults, opt || {});
  
      var highlight = opt.highlight
        , tokens
        , pending
        , i = 0;
  
      try {
        tokens = Lexer.lex(src, opt)
      } catch (e) {
        return callback(e);
      }
  
      pending = tokens.length;
  
      var done = function(err) {
        if (err) {
          opt.highlight = highlight;
          return callback(err);
        }
  
        var out;
  
        try {
          out = Parser.parse(tokens, opt);
        } catch (e) {
          err = e;
        }
  
        opt.highlight = highlight;
  
        return err
          ? callback(err)
          : callback(null, out);
      };
  
      if (!highlight || highlight.length < 3) {
        return done();
      }
  
      delete opt.highlight;
  
      if (!pending) return done();
  
      for (; i < tokens.length; i++) {
        (function(token) {
          if (token.type !== 'code') {
            return --pending || done();
          }
          return highlight(token.text, token.lang, function(err, code) {
            if (err) return done(err);
            if (code == null || code === token.text) {
              return --pending || done();
            }
            token.text = code;
            token.escaped = true;
            --pending || done();
          });
        })(tokens[i]);
      }
  
      return;
    }
    try {
      if (opt) opt = merge({}, marked.defaults, opt);
      return Parser.parse(Lexer.lex(src, opt), opt);
    } catch (e) {
      e.message += '\nPlease report this to https://github.com/chjj/marked.';
      if ((opt || marked.defaults).silent) {
        return '<p>An error occured:</p><pre>'
          + escape(e.message + '', true)
          + '</pre>';
      }
      throw e;
    }
  }
  
  /**
   * Options
   */
  
  marked.options =
  marked.setOptions = function(opt) {
    merge(marked.defaults, opt);
    return marked;
  };
  
  marked.defaults = {
    gfm: true,
    tables: true,
    breaks: false,
    pedantic: false,
    sanitize: false,
    sanitizer: null,
    mangle: true,
    smartLists: false,
    silent: false,
    highlight: null,
    langPrefix: 'lang-',
    smartypants: false,
    headerPrefix: '',
    renderer: new Renderer,
    xhtml: false
  };
  
  /**
   * Expose
   */
  
  marked.Parser = Parser;
  marked.parser = Parser.parse;
  
  marked.Renderer = Renderer;
  
  marked.Lexer = Lexer;
  marked.lexer = Lexer.lex;
  
  marked.InlineLexer = InlineLexer;
  marked.inlineLexer = InlineLexer.output;
  
  marked.parse = marked;
  
  if (typeof module !== 'undefined' && typeof exports === 'object') {
    module.exports = marked;
  } else if (typeof define === 'function' && define.amd) {
    define('components/marked/lib/marked',[],function() { return marked; });
  } else {
    this.marked = marked;
  }
  
  }).call(function() {
    return this || (typeof window !== 'undefined' ? window : global);
}());


var notebookJsCelltoolbar = (function notebookJsCelltoolbar() {
    "use strict";

    var events = baseJsEvent;

    var CellToolbar = function (options) {
        /**
         * Constructor
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          cell: Cell instance
         *          notebook: Notebook instance
         *
         *  TODO: This leaks, when cell are deleted
         *  There is still a reference to each celltoolbars.
         */
        CellToolbar._instances.push(this);
        this.notebook = options.notebook;
        this.cell = options.cell;
        this.create_element();
        this.rebuild();
        return this;
    };


    CellToolbar.prototype.create_element = function () {
        this.inner_element = $('<div/>').addClass('celltoolbar');
        this.element = $('<div/>').addClass('ctb_hideshow')
            .append(this.inner_element);
    };


    // The default css style for the outer celltoolbar div
    // (ctb_hideshow) is display: none.
    // To show the cell toolbar, *both* of the following conditions must be met:
    // - A parent container has class `ctb_global_show`
    // - The celltoolbar has the class `ctb_show`
    // This allows global show/hide, as well as per-cell show/hide.

    CellToolbar.global_hide = function () {
        $('body').removeClass('ctb_global_show');
    };


    CellToolbar.global_show = function () {
        $('body').addClass('ctb_global_show');
    };


    CellToolbar.prototype.hide = function () {
        this.element.removeClass('ctb_show');
    };


    CellToolbar.prototype.show = function () {
        this.element.addClass('ctb_show');
    };


    /**
     * Class variable that should contain a dict of all available callback
     * we need to think of wether or not we allow nested namespace
     * @property _callback_dict
     * @private
     * @static
     * @type Dict
     */
    CellToolbar._callback_dict = {};


    /**
     * Class variable that should contain the reverse order list of the button
     * to add to the toolbar of each cell
     * @property _ui_controls_list
     * @private
     * @static
     * @type List
     */
    CellToolbar._ui_controls_list = [];


    /**
     * Class variable that should contain the CellToolbar instances for each
     * cell of the notebook
     *
     * @private
     * @property _instances
     * @static
     * @type List
     */
    CellToolbar._instances = [];


    /**
     * keep a list of all the available presets for the toolbar
     * @private
     * @property _presets
     * @static
     * @type Dict
     */
    CellToolbar._presets = {};


    // this is by design not a prototype.
    /**
     * Register a callback to create an UI element in a cell toolbar.
     * @method register_callback
     * @param name {String} name to use to refer to the callback. It is advised to use a prefix with the name
     * for easier sorting and avoid collision
     * @param callback {function(div, cell)} callback that will be called to generate the ui element
     * @param [cell_types] {List_of_String|undefined} optional list of cell types. If present the UI element
     * will be added only to cells of types in the list.
     *
     *
     * The callback will receive the following element :
     *
     *    * a div in which to add element.
     *    * the cell it is responsible from
     *
     * @example
     *
     * Example that create callback for a button that toggle between `true` and `false` label,
     * with the metadata under the key 'foo' to reflect the status of the button.
     *
     *      // first param reference to a DOM div
     *      // second param reference to the cell.
     *      var toggle =  function(div, cell) {
     *          var button_container = $(div)
     *
     *          // let's create a button that show the  current value of the metadata
     *          var button = $('<div/>').button({label:String(cell.metadata.foo)});
     *
     *          // On click, change the metadata value and update the button label
     *          button.click(function(){
     *                      var v = cell.metadata.foo;
     *                      cell.metadata.foo = !v;
     *                      button.button("option", "label", String(!v));
     *                  })
     *
     *          // add the button to the DOM div.
     *          button_container.append(button);
     *      }
     *
     *      // now we register the callback under the name `foo` to give the
     *      // user the ability to use it later
     *      CellToolbar.register_callback('foo', toggle);
     */
    CellToolbar.register_callback = function(name, callback, cell_types) {
        // Overwrite if it already exists.
        CellToolbar._callback_dict[name] = cell_types ? {callback: callback, cell_types: cell_types} : callback;
    };


    /**
     * Register a preset of UI element in a cell toolbar.
     * Not supported Yet.
     * @method register_preset
     * @param name {String} name to use to refer to the preset. It is advised to use a prefix with the name
     * for easier sorting and avoid collision
     * @param  preset_list {List_of_String} reverse order of the button in the toolbar. Each String of the list
     *          should correspond to a name of a registerd callback.
     *
     * @private
     * @example
     *
     *      CellToolbar.register_callback('foo.c1', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c2', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c3', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c4', function(div, cell){...});
     *      CellToolbar.register_callback('foo.c5', function(div, cell){...});
     *
     *      CellToolbar.register_preset('foo.foo_preset1', ['foo.c1', 'foo.c2', 'foo.c5'])
     *      CellToolbar.register_preset('foo.foo_preset2', ['foo.c4', 'foo.c5'])
     */
    CellToolbar.register_preset = function(name, preset_list, notebook) {
        CellToolbar._presets[name] = preset_list;
        events.trigger('preset_added.CellToolbar', {name: name});
        // When "register_callback" is called by a custom extension, it may be executed after notebook is loaded.
        // In that case, activate the preset if needed.
        if (notebook && notebook.metadata && notebook.metadata.celltoolbar === name){
            CellToolbar.activate_preset(name);
        }
    };

    /**
     * unregister the selected preset,
     *
     * return true if preset successfully unregistered
     * false otherwise
     *
     **/
    CellToolbar.unregister_preset = function(name){
        if(CellToolbar._presets[name]){
            delete CellToolbar._presets[name];
            events.trigger('unregistered_preset.CellToolbar', {name: name});
            return true
        }
        return false
    }


    /**
     * List the names of the presets that are currently registered.
     *
     * @method list_presets
     * @static
     */
    CellToolbar.list_presets = function() {
        var keys = [];
        for (var k in CellToolbar._presets) {
            keys.push(k);
        }
        return keys;
    };


    /**
     * Activate an UI preset from `register_preset`
     *
     * This does not update the selection UI.
     *
     * @method activate_preset
     * @param preset_name {String} string corresponding to the preset name
     *
     * @static
     * @private
     * @example
     *
     *      CellToolbar.activate_preset('foo.foo_preset1');
     */
    CellToolbar.activate_preset = function(preset_name){
        var preset = CellToolbar._presets[preset_name];

        if(preset !== undefined){
            CellToolbar._ui_controls_list = preset;
            CellToolbar.rebuild_all();
        }

        events.trigger('preset_activated.CellToolbar', {name: preset_name});
    };


    /**
     * This should be called on the class and not on a instance as it will trigger
     * rebuild of all the instances.
     * @method rebuild_all
     * @static
     *
     */
    CellToolbar.rebuild_all = function(){
        for(var i=0; i < CellToolbar._instances.length; i++){
            CellToolbar._instances[i].rebuild();
        }
    };

    /**
     * Rebuild all the button on the toolbar to update its state.
     * @method rebuild
     */
    CellToolbar.prototype.rebuild = function(){
        /**
         * strip evrything from the div
         * which is probably inner_element
         * or this.element.
         */
        this.inner_element.empty();
        this.ui_controls_list = [];

        var callbacks = CellToolbar._callback_dict;
        var preset = CellToolbar._ui_controls_list;
        // Yes we iterate on the class variable, not the instance one.
        for (var i=0; i < preset.length; i++) {
            var key = preset[i];
            var callback = callbacks[key];
            if (!callback) continue;

            if (typeof callback === 'object') {
                if (callback.cell_types.indexOf(this.cell.cell_type) === -1) continue;
                callback = callback.callback;
            }

            var local_div = $('<div/>').addClass('button_container');
            try {
                callback(local_div, this.cell, this);
                this.ui_controls_list.push(key);
            } catch (e) {
                console.log("Error in cell toolbar callback " + key, e);
                continue;
            }
            // only append if callback succeeded.
            this.inner_element.append(local_div);
        }

        // If there are no controls or the cell is a rendered TextCell hide the toolbar.
        if (!this.ui_controls_list.length) {
            this.hide();
        } else {
            this.show();
        }
    };


    CellToolbar.utils = {};


    /**
     * A utility function to generate bindings between a checkbox and cell/metadata
     * @method utils.checkbox_ui_generator
     * @static
     *
     * @param name {string} Label in front of the checkbox
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value.
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     * @example
     *
     * An exmple that bind the subkey `slideshow.isSectionStart` to a checkbox with a `New Slide` label
     *
     *     var newSlide = CellToolbar.utils.checkbox_ui_generator('New Slide',
     *          // setter
     *          function(cell, value){
     *              // we check that the slideshow namespace exist and create it if needed
     *              if (cell.metadata.slideshow == undefined){cell.metadata.slideshow = {}}
     *              // set the value
     *              cell.metadata.slideshow.isSectionStart = value
     *              },
     *          //geter
     *          function(cell){ var ns = cell.metadata.slideshow;
     *              // if the slideshow namespace does not exist return `undefined`
     *              // (will be interpreted as `false` by checkbox) otherwise
     *              // return the value
     *              return (ns == undefined)? undefined: ns.isSectionStart
     *              }
     *      );
     *
     *      CellToolbar.register_callback('newSlide', newSlide);
     *
     */
    CellToolbar.utils.checkbox_ui_generator = function(name, setter, getter){
        return function(div, cell, celltoolbar) {
            var button_container = $(div);

            var chkb = $('<input/>').attr('type', 'checkbox');
            var lbl = $('<label/>').append($('<span/>').text(name));
            lbl.append(chkb);
            chkb.attr("checked", getter(cell));

            chkb.click(function(){
                        var v = getter(cell);
                        setter(cell, !v);
                        chkb.attr("checked", !v);
            });
            button_container.append($('<span/>').append(lbl));
        };
    };


    /**
     * A utility function to generate bindings between a input field and cell/metadata
     * @method utils.input_ui_generator
     * @static
     *
     * @param name {string} Label in front of the input field
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value.
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     */
    CellToolbar.utils.input_ui_generator = function(name, setter, getter){
        return function(div, cell, celltoolbar) {
            var button_container = $(div);

            var text = $('<input/>').attr('type', 'text');
            var lbl = $('<label/>').append($('<span/>').text(name));
            lbl.append(text);
            text.attr("value", getter(cell));

            text.keyup(function(){
                setter(cell, text.val());
            });
            button_container.append($('<span/>').append(lbl));
            IPython.keyboard_manager.register_events(text);
        };
    };

    /**
     * A utility function to generate bindings between a dropdown list cell
     * @method utils.select_ui_generator
     * @static
     *
     * @param list_list {list_of_sublist} List of sublist of metadata value and name in the dropdown list.
     *        subslit shoud contain 2 element each, first a string that woul be displayed in the dropdown list,
     *        and second the corresponding value to  be passed to setter/return by getter. the corresponding value
     *        should not be "undefined" or behavior can be unexpected.
     * @param setter {function( cell, newValue )}
     *        A setter method to set the newValue
     * @param getter {function( cell )}
     *        A getter methods which return the current value of the metadata.
     * @param [label=""] {String} optionnal label for the dropdown menu
     *
     * @return callback {function( div, cell )} Callback to be passed to `register_callback`
     *
     * @example
     *
     *      var select_type = CellToolbar.utils.select_ui_generator([
     *              ["<None>"       , "None"      ],
     *              ["Header Slide" , "header_slide" ],
     *              ["Slide"        , "slide"        ],
     *              ["Fragment"     , "fragment"     ],
     *              ["Skip"         , "skip"         ],
     *              ],
     *              // setter
     *              function(cell, value){
     *                  // we check that the slideshow namespace exist and create it if needed
     *                  if (cell.metadata.slideshow == undefined){cell.metadata.slideshow = {}}
     *                  // set the value
     *                  cell.metadata.slideshow.slide_type = value
     *                  },
     *              //geter
     *              function(cell){ var ns = cell.metadata.slideshow;
     *                  // if the slideshow namespace does not exist return `undefined`
     *                  // (will be interpreted as `false` by checkbox) otherwise
     *                  // return the value
     *                  return (ns == undefined)? undefined: ns.slide_type
     *                  }
     *      CellToolbar.register_callback('slideshow.select', select_type);
     *
     */
    CellToolbar.utils.select_ui_generator = function(list_list, setter, getter, label) {
        label = label || "";
        return function(div, cell, celltoolbar) {
            var button_container = $(div);
            var lbl = $("<label/>").append($('<span/>').text(label));
            var select = $('<select/>');
            for(var i=0; i < list_list.length; i++){
                var opt = $('<option/>')
                    .attr('value', list_list[i][1])
                    .text(list_list[i][0]);
                select.append(opt);
            }
            select.val(getter(cell));
            select.change(function(){
                        setter(cell, select.val());
                    });
            button_container.append($('<span/>').append(lbl).append(select));
        };
    };

    // Backwards compatability.
    IPython.CellToolbar = CellToolbar;

    return {'CellToolbar': CellToolbar};
})();

var notebookJsTextCell = (function notebookJsTextCell() {
    "use strict";

    var utils = baseJsUtils;
    var cell = notebookJsCell;
    var security = baseJsSecurity;
    var configmod = serviceConfig;
    var mathjaxutils = notebookJsMathjaxutils;
    var celltoolbar = notebookJsCelltoolbar;
    // var marked = marked;


    var Cell = cell.Cell;

    var TextCell = function (options) {
        /**
         * Constructor
         *
         * Construct a new TextCell, codemirror mode is by default 'htmlmixed',
         * and cell type is 'text' cell start as not redered.
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          config: dictionary
         *          keyboard_manager: KeyboardManager instance
         *          notebook: Notebook instance
         */
        options = options || {};

        // in all TextCell/Cell subclasses
        // do not assign most of members here, just pass it down
        // in the options dict potentially overwriting what you wish.
        // they will be assigned in the base class.
        this.notebook = options.notebook;
        this.events = options.events;
        this.config = options.config;

        // we cannot put this as a class key as it has handle to "this".
        var config = utils.mergeopt(TextCell, this.config);
        Cell.apply(this, [{
                    config: config,
                    keyboard_manager: options.keyboard_manager,
                    events: this.events}]);

        this.cell_type = this.cell_type || 'text';
        mathjaxutils = mathjaxutils;
        this.rendered = false;
    };

    TextCell.prototype = Object.create(Cell.prototype);

    TextCell.options_default = {
        cm_config : {
            extraKeys: {"Tab": "indentMore","Shift-Tab" : "indentLess"},
            mode: 'htmlmixed',
            lineWrapping : true,
            readOnly: 'nocursor'
        }
    };


    /**
     * Create the DOM element of the TextCell
     * @method create_element
     * @private
     */
    TextCell.prototype.create_element = function () {
        Cell.prototype.create_element.apply(this, arguments);
        var that = this;

        var cell = $("<div>").addClass('cell text_cell');
        cell.attr('tabindex','2');

        var prompt = $('<div/>').addClass('prompt input_prompt');
        cell.append(prompt);
        var inner_cell = $('<div/>').addClass('inner_cell');
        this.celltoolbar = new celltoolbar.CellToolbar({
            cell: this,
            notebook: this.notebook});
        inner_cell.append(this.celltoolbar.element);
        var input_area = $('<div/>').addClass('input_area');
        this.code_mirror = new CodeMirror(input_area.get(0), this._options.cm_config);
        // In case of bugs that put the keyboard manager into an inconsistent state,
        // ensure KM is enabled when CodeMirror is focused:
        this.code_mirror.on('focus', function () {
            if (that.keyboard_manager) {
                that.keyboard_manager.enable();
            }
        });
        this.code_mirror.on('keydown', $.proxy(this.handle_keyevent,this))
        // The tabindex=-1 makes this div focusable.
        var render_area = $('<div/>').addClass('text_cell_render rendered_html')
            .attr('tabindex','-1');
        inner_cell.append(input_area).append(render_area);
        cell.append(inner_cell);
        this.element = cell;
    };


    // Cell level actions

    TextCell.prototype.select = function () {
        var cont = Cell.prototype.select.apply(this);
        if (cont) {
            if (this.mode === 'edit') {
                this.code_mirror.refresh();
            }
        }
        return cont;
    };

    TextCell.prototype.unrender = function () {
        var cont = Cell.prototype.unrender.apply(this);
        if (cont) {
            var text_cell = this.element;
            if (this.get_text() === this.placeholder) {
                this.set_text('');
            }
            this.refresh();
        }
        return cont;
    };

    TextCell.prototype.execute = function () {
        this.render();
    };

    /**
     * setter: {{#crossLink "TextCell/set_text"}}{{/crossLink}}
     * @method get_text
     * @retrun {string} CodeMirror current text value
     */
    TextCell.prototype.get_text = function() {
        return this.code_mirror.getValue();
    };

    /**
     * @param {string} text - Codemiror text value
     * @see TextCell#get_text
     * @method set_text
     * */
    TextCell.prototype.set_text = function(text) {
        text = $.isArray(text) ? text.join('') : text;
        this.code_mirror.setValue(text);
        this.unrender();
        this.code_mirror.refresh();
    };

    /**
     * setter :{{#crossLink "TextCell/set_rendered"}}{{/crossLink}}
     * @method get_rendered
     * */
    TextCell.prototype.get_rendered = function() {
        return this.element.find('div.text_cell_render').html();
    };

    /**
     * @method set_rendered
     */
    TextCell.prototype.set_rendered = function(text) {
        this.element.find('div.text_cell_render').html(text);
    };


    /**
     * Create Text cell from JSON
     * @param {json} data - JSON serialized text-cell
     * @method fromJSON
     */
    TextCell.prototype.fromJSON = function (data) {
        Cell.prototype.fromJSON.apply(this, arguments);
        if (data.cell_type === this.cell_type) {
            if (data.source !== undefined) {
                this.set_text(data.source);
                // make this value the starting point, so that we can only undo
                // to this state, instead of a blank cell
                this.code_mirror.clearHistory();
                // TODO: This HTML needs to be treated as potentially dangerous
                // user input and should be handled before set_rendered.
                this.set_rendered(data.rendered || '');
                this.rendered = false;
                this.render();
            }
        }
    };

    /** Generate JSON from cell
     * @return {object} cell data serialised to json
     */
    TextCell.prototype.toJSON = function () {
        var data = Cell.prototype.toJSON.apply(this);
        data.source = this.get_text();
        if (data.source == this.placeholder) {
            data.source = "";
        }
        return data;
    };


    var MarkdownCell = function (options) {
        /**
         * Constructor
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          config: ConfigSection instance
         *          keyboard_manager: KeyboardManager instance
         *          notebook: Notebook instance
         */
        options = options || {};
        var config = utils.mergeopt(MarkdownCell, {});
        this.class_config = new configmod.ConfigWithDefaults(options.config,
                                            {}, 'MarkdownCell');
        TextCell.apply(this, [$.extend({}, options, {config: config})]);

        this.cell_type = 'markdown';
    };

    MarkdownCell.options_default = {
        cm_config: {
            mode: 'ipythongfm',
            readOnly: 'nocursor'
        },
        placeholder: "Type *Markdown* and LaTeX: $\\alpha^2$"
    };

    MarkdownCell.prototype = Object.create(TextCell.prototype);

    MarkdownCell.prototype.set_heading_level = function (level) {
        /**
         * make a markdown cell a heading
         */
        level = level || 1;
        var source = this.get_text();
        source = source.replace(/^(#*)\s?/,
            new Array(level + 1).join('#') + ' ');
        this.set_text(source);
        this.refresh();
        if (this.rendered) {
            this.render();
        }
    };

    /**
     * @method render
     */
    MarkdownCell.prototype.render = function () {
        var cont = TextCell.prototype.render.apply(this);
        if (cont) {
            var that = this;
            var text = this.get_text();
            var math = null;
            if (text === "") { text = this.placeholder; }
            var text_and_math = mathjaxutils.remove_math(text);
            text = text_and_math[0];
            math = text_and_math[1];
            marked(text, function (err, html) {
                html = mathjaxutils.replace_math(html, math);
                html = security.sanitize_html(html);
                html = $($.parseHTML(html));
                // add anchors to headings
                html.find(":header").addBack(":header").each(function (i, h) {
                    h = $(h);
                    var hash = h.text().replace(/ /g, '-');
                    h.attr('id', hash);
                    h.append(
                        $('<a/>')
                            .addClass('anchor-link')
                            .attr('href', '#' + hash)
                            .text('¶')
                    );
                });
                // links in markdown cells should open in new tabs
                html.find("a[href]").not('[href^="#"]').attr("target", "_blank");
                that.set_rendered(html);
                that.typeset();
                that.events.trigger("rendered.MarkdownCell", {cell: that});
            });
        }
        return cont;
    };


    var RawCell = function (options) {
        /**
         * Constructor
         *
         * Parameters:
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance
         *          config: ConfigSection instance
         *          keyboard_manager: KeyboardManager instance
         *          notebook: Notebook instance
         */
        options = options || {};
        var config = utils.mergeopt(RawCell, {});
        TextCell.apply(this, [$.extend({}, options, {config: config})]);

        this.class_config = new configmod.ConfigWithDefaults(options.config,
                                            RawCell.config_defaults, 'RawCell');
        this.cell_type = 'raw';
    };

    RawCell.options_default = {
        placeholder : "Write raw LaTeX or other formats here, for use with nbconvert. " +
            "It will not be rendered in the notebook. " +
            "When passing through nbconvert, a Raw Cell's content is added to the output unmodified."
    };

    RawCell.config_defaults =  {
        highlight_modes : {
            'diff'         :{'reg':[/^diff/]}
        },
    };

    RawCell.prototype = Object.create(TextCell.prototype);

    /** @method bind_events **/
    RawCell.prototype.bind_events = function () {
        TextCell.prototype.bind_events.apply(this);
        var that = this;
        this.element.focusout(function() {
            that.auto_highlight();
            that.render();
        });

        this.code_mirror.on('focus', function() { that.unrender(); });
    };

    /** @method render **/
    RawCell.prototype.render = function () {
        var cont = TextCell.prototype.render.apply(this);
        if (cont){
            var text = this.get_text();
            if (text === "") { text = this.placeholder; }
            this.set_text(text);
            this.element.removeClass('rendered');
            this.auto_highlight();
        }
        return cont;
    };

    var textcell = {
        TextCell: TextCell,
        MarkdownCell: MarkdownCell,
        RawCell: RawCell
    };
    return textcell;
})();

// 'services/kernels/serialize'
var servicesKernelsSerialize = (function servicesKernelsSerialize () {
  "use strict";

  var _deserialize_array_buffer = function (buf) {
      var data = new DataView(buf);
      // read the header: 1 + nbufs 32b integers
      var nbufs = data.getUint32(0);
      var offsets = [];
      var i;
      for (i = 1; i <= nbufs; i++) {
          offsets.push(data.getUint32(i * 4));
      }
      var json_bytes = new Uint8Array(buf.slice(offsets[0], offsets[1]));
      var msg = JSON.parse(
          (new TextDecoder('utf8')).decode(json_bytes)
      );
      // the remaining chunks are stored as DataViews in msg.buffers
      msg.buffers = [];
      var start, stop;
      for (i = 1; i < nbufs; i++) {
          start = offsets[i];
          stop = offsets[i+1] || buf.byteLength;
          msg.buffers.push(new DataView(buf.slice(start, stop)));
      }
      return msg;
  };

  var _deserialize_binary = function(data) {
      /**
       * deserialize the binary message format
       * callback will be called with a message whose buffers attribute
       * will be an array of DataViews.
       */
      if (data instanceof Blob) {
          // data is Blob, have to deserialize from ArrayBuffer in reader callback
          var reader = new FileReader();
          var promise = new Promise(function(resolve, reject) {
              reader.onload = function () {
                  var msg = _deserialize_array_buffer(this.result);
                  resolve(msg);
              };
          });
          reader.readAsArrayBuffer(data);
          return promise;
      } else {
          // data is ArrayBuffer, can deserialize directly
          var msg = _deserialize_array_buffer(data);
          return msg;
      }
  };

  var deserialize = function (data) {
      /**
       * deserialize a message and return a promise for the unpacked message
       */
      if (typeof data === "string") {
          // text JSON message
          return Promise.resolve(JSON.parse(data));
      } else {
          // binary message
          return Promise.resolve(_deserialize_binary(data));
      }
  };

  var _serialize_binary = function (msg) {
      /**
       * implement the binary serialization protocol
       * serializes JSON message to ArrayBuffer
       */
      msg = _.clone(msg);
      var offsets = [];
      var buffers = [];
      var i;
      for (i = 0; i < msg.buffers.length; i++) {
          // msg.buffers elements could be either views or ArrayBuffers
          // buffers elements are ArrayBuffers
          var b = msg.buffers[i];
          buffers.push(b.buffer instanceof ArrayBuffer ? b.buffer : b);
      }
      delete msg.buffers;
      var json_utf8 = (new TextEncoder('utf8')).encode(JSON.stringify(msg));
      buffers.unshift(json_utf8);
      var nbufs = buffers.length;
      offsets.push(4 * (nbufs + 1));
      for (i = 0; i + 1 < buffers.length; i++) {
          offsets.push(offsets[offsets.length-1] + buffers[i].byteLength);
      }
      var msg_buf = new Uint8Array(
          offsets[offsets.length-1] + buffers[buffers.length-1].byteLength
      );
      // use DataView.setUint32 for network byte-order
      var view = new DataView(msg_buf.buffer);
      // write nbufs to first 4 bytes
      view.setUint32(0, nbufs);
      // write offsets to next 4 * nbufs bytes
      for (i = 0; i < offsets.length; i++) {
          view.setUint32(4 * (i+1), offsets[i]);
      }
      // write all the buffers at their respective offsets
      for (i = 0; i < buffers.length; i++) {
          msg_buf.set(new Uint8Array(buffers[i]), offsets[i]);
      }

      // return raw ArrayBuffer
      return msg_buf.buffer;
  };

  var serialize = function (msg) {
      if (msg.buffers && msg.buffers.length) {
          return _serialize_binary(msg);
      } else {
          return JSON.stringify(msg);
      }
  };

  var exports = {
      deserialize : deserialize,
      serialize: serialize
  };
  return exports;
})();

// services/kernels/comm
var servicesKernelsComm = (function servicesKernelsComm() {
	"use strict";

	var utils = baseJsUtils;
	//-----------------------------------------------------------------------
	// CommManager class
	//-----------------------------------------------------------------------

	var CommManager = function (kernel) {
			this.comms = {};
			this.targets = {};
			if (kernel !== undefined) {
					this.init_kernel(kernel);
			}
	};

	CommManager.prototype.init_kernel = function (kernel) {
			/**
			 * connect the kernel, and register message handlers
			 */
			this.kernel = kernel;
			var msg_types = ['comm_open', 'comm_msg', 'comm_close'];
			for (var i = 0; i < msg_types.length; i++) {
					var msg_type = msg_types[i];
					kernel.register_iopub_handler(msg_type, $.proxy(this[msg_type], this));
			}
	};

	CommManager.prototype.new_comm = function (target_name, data, callbacks, metadata, comm_id) {
			/**
			 * Create a new Comm, register it, and open its Kernel-side counterpart
			 * Mimics the auto-registration in `Comm.__init__` in the Jupyter Comm.
			 *
			 * argument comm_id is optional
			 */
			var comm = new Comm(target_name, comm_id);
			this.register_comm(comm);
			comm.open(data, callbacks, metadata);
			return comm;
	};

	CommManager.prototype.register_target = function (target_name, f) {
			/**
			 * Register a target function for a given target name
			 */
			this.targets[target_name] = f;
	};

	CommManager.prototype.unregister_target = function (target_name, f) {
			/**
			 * Unregister a target function for a given target name
			 */
			delete this.targets[target_name];
	};

	CommManager.prototype.register_comm = function (comm) {
			/**
			 * Register a comm in the mapping
			 */
			this.comms[comm.comm_id] = Promise.resolve(comm);
			comm.kernel = this.kernel;
			return comm.comm_id;
	};

	CommManager.prototype.unregister_comm = function (comm) {
			/**
			 * Remove a comm from the mapping
			 */
			delete this.comms[comm.comm_id];
	};

	// comm message handlers

	CommManager.prototype.comm_open = function (msg) {
			var content = msg.content;
			var that = this;
			var comm_id = content.comm_id;

			this.comms[comm_id] = utils.load_class(content.target_name, content.target_module,
					this.targets).then(function(target) {
							var comm = new Comm(content.target_name, comm_id);
							comm.kernel = that.kernel;
							try {
									var response = target(comm, msg);
							} catch (e) {
									comm.close();
									that.unregister_comm(comm);
									var wrapped_error = new utils.WrappedError("Exception opening new comm", e);
									console.error(wrapped_error);
									return Promise.reject(wrapped_error);
							}
							// Regardless of the target return value, we need to
							// then return the comm
							return Promise.resolve(response).then(function() {return comm;});
					}, utils.reject('Could not open comm', true));
			return this.comms[comm_id];
	};

	CommManager.prototype.comm_close = function(msg) {
			var content = msg.content;
			if (this.comms[content.comm_id] === undefined) {
					console.error('Comm promise not found for comm id ' + content.comm_id);
					return;
			}
			var that = this;
			this.comms[content.comm_id] = this.comms[content.comm_id].then(function(comm) {
					that.unregister_comm(comm);
					try {
							comm.handle_close(msg);
					} catch (e) {
							console.log("Exception closing comm: ", e, e.stack, msg);
					}
					// don't return a comm, so that further .then() functions
					// get an undefined comm input
			});
			return this.comms[content.comm_id];
	};

	CommManager.prototype.comm_msg = function(msg) {
			var content = msg.content;
			if (this.comms[content.comm_id] === undefined) {
					console.error('Comm promise not found for comm id ' + content.comm_id);
					return;
			}

			this.comms[content.comm_id] = this.comms[content.comm_id].then(function(comm) {
					try {
							comm.handle_msg(msg);
					} catch (e) {
							console.log("Exception handling comm msg: ", e, e.stack, msg);
					}
					return comm;
			});
			return this.comms[content.comm_id];
	};

	//-----------------------------------------------------------------------
	// Comm base class
	//-----------------------------------------------------------------------

	var Comm = function (target_name, comm_id) {
			this.target_name = target_name;
			this.comm_id = comm_id || utils.uuid();
			this._msg_callback = this._close_callback = null;
	};

	// methods for sending messages
	Comm.prototype.open = function (data, callbacks, metadata) {
			var content = {
					comm_id : this.comm_id,
					target_name : this.target_name,
					data : data || {},
			};
			return this.kernel.send_shell_message("comm_open", content, callbacks, metadata);
	};

	Comm.prototype.send = function (data, callbacks, metadata, buffers) {
			var content = {
					comm_id : this.comm_id,
					data : data || {},
			};
			return this.kernel.send_shell_message("comm_msg", content, callbacks, metadata, buffers);
	};

	Comm.prototype.close = function (data, callbacks, metadata) {
			var content = {
					comm_id : this.comm_id,
					data : data || {},
			};
			return this.kernel.send_shell_message("comm_close", content, callbacks, metadata);
	};

	// methods for registering callbacks for incoming messages
	Comm.prototype._register_callback = function (key, callback) {
			this['_' + key + '_callback'] = callback;
	};

	Comm.prototype.on_msg = function (callback) {
			this._register_callback('msg', callback);
	};

	Comm.prototype.on_close = function (callback) {
			this._register_callback('close', callback);
	};

	// methods for handling incoming messages

	Comm.prototype._callback = function (key, msg) {
			var callback = this['_' + key + '_callback'];
			if (callback) {
					try {
							callback(msg);
					} catch (e) {
							console.log("Exception in Comm callback", e, e.stack, msg);
					}
			}
	};

	Comm.prototype.handle_msg = function (msg) {
			this._callback('msg', msg);
	};

	Comm.prototype.handle_close = function (msg) {
			this._callback('close', msg);
	};

	return {
			'CommManager': CommManager,
			'Comm': Comm
	};
})();

// services/kernels/kernel
var servicesKernelsKernel = (function servicesKernelsKernel() {
	"use strict";

	var utils = baseJsUtils;
	var comm = servicesKernelsComm;
	var serialize = servicesKernelsSerialize;
	var events = baseJsEvent;

	/**
	 * A Kernel class to communicate with the Python kernel. This
	 * should generally not be constructed directly, but be created
	 * by.  the `Session` object. Once created, this object should be
	 * used to communicate with the kernel.
	 *
	 * Preliminary documentation for the REST API is at
	 * https://github.com/ipython/ipython/wiki/IPEP-16%3A-Notebook-multi-directory-dashboard-and-URL-mapping#kernels-api
	 *
	 * @class Kernel
	 * @param {string} kernel_service_url - the URL to access the kernel REST api
	 * @param {string} ws_url - the websockets URL
	 * @param {string} name - the kernel type (e.g. python3)
	 */
	var Kernel = function (kernel_service_url, ws_url, name) {
			this.events = events;

			this.id = null;
			this.name = name;
			this.ws = null;

			this.kernel_service_url = kernel_service_url;
			this.kernel_url = null;
			this.ws_url = ws_url || utils.get_body_data("wsUrl");
			if (!this.ws_url) {
					// trailing 's' in https will become wss for secure web sockets
					this.ws_url = location.protocol.replace('http', 'ws') + "//" + location.host;
			}

			this.username = "username";
			this.session_id = utils.uuid();
			this._msg_callbacks = {};
			this._msg_queue = Promise.resolve();
			this.info_reply = {}; // kernel_info_reply stored here after starting

			if (typeof(WebSocket) !== 'undefined') {
					this.WebSocket = WebSocket;
			} else if (typeof(MozWebSocket) !== 'undefined') {
					this.WebSocket = MozWebSocket;
			} else {
					alert('Your browser does not have WebSocket support, please try Chrome, Safari or Firefox ≥ 6. Firefox 4 and 5 are also supported by you have to enable WebSockets in about:config.');
			}

			this.bind_events();
			this.init_iopub_handlers();
			this.comm_manager = new comm.CommManager(this);

			this.last_msg_id = null;
			this.last_msg_callbacks = {};

			this._autorestart_attempt = 0;
			this._reconnect_attempt = 0;
			this.reconnect_limit = 7;
	};

	/**
	 * @function _get_msg
	 */
	Kernel.prototype._get_msg = function (msg_type, content, metadata, buffers) {
			var msg = {
					header : {
							msg_id : utils.uuid(),
							username : this.username,
							session : this.session_id,
							msg_type : msg_type,
							version : "5.0"
					},
					metadata : metadata || {},
					content : content,
					buffers : buffers || [],
					parent_header : {}
			};
			return msg;
	};

	/**
	 * @function bind_events
	 */
	Kernel.prototype.bind_events = function () {
			var that = this;
			this.events.on('send_input_reply.Kernel', function(evt, data) {
					that.send_input_reply(data);
			});

			var record_status = function (evt, info) {
					console.log('Kernel: ' + evt.type + ' (' + info.kernel.id + ')');
			};

			this.events.on('kernel_created.Kernel', record_status);
			this.events.on('kernel_reconnecting.Kernel', record_status);
			this.events.on('kernel_connected.Kernel', record_status);
			this.events.on('kernel_starting.Kernel', record_status);
			this.events.on('kernel_restarting.Kernel', record_status);
			this.events.on('kernel_autorestarting.Kernel', record_status);
			this.events.on('kernel_interrupting.Kernel', record_status);
			this.events.on('kernel_disconnected.Kernel', record_status);
			// these are commented out because they are triggered a lot, but can
			// be uncommented for debugging purposes
			//this.events.on('kernel_idle.Kernel', record_status);
			//this.events.on('kernel_busy.Kernel', record_status);
			this.events.on('kernel_ready.Kernel', record_status);
			this.events.on('kernel_killed.Kernel', record_status);
			this.events.on('kernel_dead.Kernel', record_status);

			this.events.on('kernel_ready.Kernel', function () {
					that._autorestart_attempt = 0;
			});
			this.events.on('kernel_connected.Kernel', function () {
					that._reconnect_attempt = 0;
			});
	};

	/**
	 * Initialize the iopub handlers.
	 *
	 * @function init_iopub_handlers
	 */
	Kernel.prototype.init_iopub_handlers = function () {
			var output_msg_types = ['stream', 'display_data', 'execute_result', 'error'];
			this._iopub_handlers = {};
			this.register_iopub_handler('status', $.proxy(this._handle_status_message, this));
			this.register_iopub_handler('clear_output', $.proxy(this._handle_clear_output, this));
			this.register_iopub_handler('execute_input', $.proxy(this._handle_input_message, this));

			for (var i=0; i < output_msg_types.length; i++) {
					this.register_iopub_handler(output_msg_types[i], $.proxy(this._handle_output_message, this));
			}
	};

	/**
	 * GET /api/kernels
	 *
	 * Get the list of running kernels.
	 *
	 * @function list
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Kernel.prototype.list = function (success, error) {
			$.ajax(this.kernel_service_url, {
					processData: false,
					cache: false,
					type: "GET",
					dataType: "json",
					success: success,
					error: this._on_error(error)
			});
	};

	/**
	 * POST /api/kernels
	 *
	 * Start a new kernel.
	 *
	 * In general this shouldn't be used -- the kernel should be
	 * started through the session API. If you use this function and
	 * are also using the session API then your session and kernel
	 * WILL be out of sync!
	 *
	 * @function start
	 * @param {params} [Object] - parameters to include in the query string
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Kernel.prototype.start = function (params, success, error) {
			var url = this.kernel_service_url;
			var qs = $.param(params || {}); // query string for sage math stuff
			if (qs !== "") {
					url = url + "?" + qs;
			}

			this.events.trigger('kernel_starting.Kernel', {kernel: this});
			var that = this;
			var on_success = function (data, status, xhr) {
					that.events.trigger('kernel_created.Kernel', {kernel: that});
					that._kernel_created(data);
					if (success) {
							success(data, status, xhr);
					}
			};

			$.ajax(url, {
					processData: false,
					cache: false,
					type: "POST",
					data: JSON.stringify({name: this.name}),
					contentType: 'application/json',
					dataType: "json",
					success: this._on_success(on_success),
					error: this._on_error(error)
			});

			return url;
	};

	/**
	 * GET /api/kernels/[:kernel_id]
	 *
	 * Get information about the kernel.
	 *
	 * @function get_info
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Kernel.prototype.get_info = function (success, error) {
			$.ajax(this.kernel_url, {
					processData: false,
					cache: false,
					type: "GET",
					dataType: "json",
					success: this._on_success(success),
					error: this._on_error(error)
			});
	};

	/**
	 * DELETE /api/kernels/[:kernel_id]
	 *
	 * Shutdown the kernel.
	 *
	 * If you are also using sessions, then this function shoul NOT be
	 * used. Instead, use Session.delete. Otherwise, the session and
	 * kernel WILL be out of sync.
	 *
	 * @function kill
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Kernel.prototype.kill = function (success, error) {
			this.events.trigger('kernel_killed.Kernel', {kernel: this});
			this._kernel_dead();
			$.ajax(this.kernel_url, {
					processData: false,
					cache: false,
					type: "DELETE",
					dataType: "json",
					success: this._on_success(success),
					error: this._on_error(error)
			});
	};

	/**
	 * POST /api/kernels/[:kernel_id]/interrupt
	 *
	 * Interrupt the kernel.
	 *
	 * @function interrupt
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Kernel.prototype.interrupt = function (success, error) {
			this.events.trigger('kernel_interrupting.Kernel', {kernel: this});

			var that = this;
			var on_success = function (data, status, xhr) {
					/**
					 * get kernel info so we know what state the kernel is in
					 */
					that.kernel_info();
					if (success) {
							success(data, status, xhr);
					}
			};

			var url = utils.url_join_encode(this.kernel_url, 'interrupt');
			$.ajax(url, {
					processData: false,
					cache: false,
					type: "POST",
					contentType: false,  // there's no data with this
					dataType: "json",
					success: this._on_success(on_success),
					error: this._on_error(error)
			});
	};

	Kernel.prototype.restart = function (success, error) {
			/**
			 * POST /api/kernels/[:kernel_id]/restart
			 *
			 * Restart the kernel.
			 *
			 * @function interrupt
			 * @param {function} [success] - function executed on ajax success
			 * @param {function} [error] - functon executed on ajax error
			 */
			this.events.trigger('kernel_restarting.Kernel', {kernel: this});
			this.stop_channels();

			var that = this;
			var on_success = function (data, status, xhr) {
					that.events.trigger('kernel_created.Kernel', {kernel: that});
					that._kernel_created(data);
					if (success) {
							success(data, status, xhr);
					}
			};

			var on_error = function (xhr, status, err) {
					that.events.trigger('kernel_dead.Kernel', {kernel: that});
					that._kernel_dead();
					if (error) {
							error(xhr, status, err);
					}
			};

			var url = utils.url_join_encode(this.kernel_url, 'restart');
			$.ajax(url, {
					processData: false,
					cache: false,
					type: "POST",
					contentType: false,  // there's no data with this
					dataType: "json",
					success: this._on_success(on_success),
					error: this._on_error(on_error)
			});
	};

	Kernel.prototype.reconnect = function () {
			/**
			 * Reconnect to a disconnected kernel. This is not actually a
			 * standard HTTP request, but useful function nonetheless for
			 * reconnecting to the kernel if the connection is somehow lost.
			 *
			 * @function reconnect
			 */
			if (this.is_connected()) {
					return;
			}
			this._reconnect_attempt = this._reconnect_attempt + 1;
			this.events.trigger('kernel_reconnecting.Kernel', {
					kernel: this,
					attempt: this._reconnect_attempt,
			});
			this.start_channels();
	};

	Kernel.prototype._on_success = function (success) {
			/**
			 * Handle a successful AJAX request by updating the kernel id and
			 * name from the response, and then optionally calling a provided
			 * callback.
			 *
			 * @function _on_success
			 * @param {function} success - callback
			 */
			var that = this;
			return function (data, status, xhr) {
					if (data) {
							that.id = data.id;
							that.name = data.name;
					}
					that.kernel_url = utils.url_join_encode(that.kernel_service_url, that.id);
					if (success) {
							success(data, status, xhr);
					}
			};
	};

	Kernel.prototype._on_error = function (error) {
			/**
			 * Handle a failed AJAX request by logging the error message, and
			 * then optionally calling a provided callback.
			 *
			 * @function _on_error
			 * @param {function} error - callback
			 */
			return function (xhr, status, err) {
					utils.log_ajax_error(xhr, status, err);
					if (error) {
							error(xhr, status, err);
					}
			};
	};

	Kernel.prototype._kernel_created = function (data) {
			/**
			 * Perform necessary tasks once the kernel has been started,
			 * including actually connecting to the kernel.
			 *
			 * @function _kernel_created
			 * @param {Object} data - information about the kernel including id
			 */
			this.id = data.id;
			this.kernel_url = utils.url_join_encode(this.kernel_service_url, this.id);
			this.start_channels();
	};

	Kernel.prototype._kernel_connected = function () {
			/**
			 * Perform necessary tasks once the connection to the kernel has
			 * been established. This includes requesting information about
			 * the kernel.
			 *
			 * @function _kernel_connected
			 */
			this.events.trigger('kernel_connected.Kernel', {kernel: this});
			// get kernel info so we know what state the kernel is in
			var that = this;
			this.kernel_info(function (reply) {
					that.info_reply = reply.content;
					that.events.trigger('kernel_ready.Kernel', {kernel: that});
			});
	};

	Kernel.prototype._kernel_dead = function () {
			/**
			 * Perform necessary tasks after the kernel has died. This closing
			 * communication channels to the kernel if they are still somehow
			 * open.
			 *
			 * @function _kernel_dead
			 */
			this.stop_channels();
	};

	Kernel.prototype.start_channels = function () {
			/**
			 * Start the websocket channels.
			 * Will stop and restart them if they already exist.
			 *
			 * @function start_channels
			 */
			var that = this;
			this.stop_channels();
			var ws_host_url = this.ws_url + this.kernel_url;

			console.log("Starting WebSockets:", ws_host_url);

			this.ws = new this.WebSocket([
							that.ws_url,
							utils.url_join_encode(that.kernel_url, 'channels'),
							"?session_id=" + that.session_id
					].join('')
			);

			var already_called_onclose = false; // only alert once
			var ws_closed_early = function(evt){
					if (already_called_onclose){
							return;
					}
					already_called_onclose = true;
					if ( ! evt.wasClean ){
							// If the websocket was closed early, that could mean
							// that the kernel is actually dead. Try getting
							// information about the kernel from the API call --
							// if that fails, then assume the kernel is dead,
							// otherwise just follow the typical websocket closed
							// protocol.
							that.get_info(function () {
									that._ws_closed(ws_host_url, false);
							}, function () {
									that.events.trigger('kernel_dead.Kernel', {kernel: that});
									that._kernel_dead();
							});
					}
			};
			var ws_closed_late = function(evt){
					if (already_called_onclose){
							return;
					}
					already_called_onclose = true;
					if ( ! evt.wasClean ){
							that._ws_closed(ws_host_url, false);
					}
			};
			var ws_error = function(evt){
					if (already_called_onclose){
							return;
					}
					already_called_onclose = true;
					that._ws_closed(ws_host_url, true);
			};

			this.ws.onopen = $.proxy(this._ws_opened, this);
			this.ws.onclose = ws_closed_early;
			this.ws.onerror = ws_error;
			// switch from early-close to late-close message after 1s
			setTimeout(function() {
					if (that.ws !== null) {
							that.ws.onclose = ws_closed_late;
					}
			}, 1000);
			this.ws.onmessage = $.proxy(this._handle_ws_message, this);
	};

	Kernel.prototype._ws_opened = function (evt) {
			/**
			 * Handle a websocket entering the open state,
			 * signaling that the kernel is connected when websocket is open.
			 *
			 * @function _ws_opened
			 */
			if (this.is_connected()) {
					// all events ready, trigger started event.
					this._kernel_connected();
			}
	};

	Kernel.prototype._ws_closed = function(ws_url, error) {
			/**
			 * Handle a websocket entering the closed state.  If the websocket
			 * was not closed due to an error, try to reconnect to the kernel.
			 *
			 * @function _ws_closed
			 * @param {string} ws_url - the websocket url
			 * @param {bool} error - whether the connection was closed due to an error
			 */
			this.stop_channels();

			this.events.trigger('kernel_disconnected.Kernel', {kernel: this});
			if (error) {
					console.log('WebSocket connection failed: ', ws_url);
					this.events.trigger('kernel_connection_failed.Kernel', {kernel: this, ws_url: ws_url, attempt: this._reconnect_attempt});
			}
			this._schedule_reconnect();
	};

	Kernel.prototype._schedule_reconnect = function () {
			/**
			 * function to call when kernel connection is lost
			 * schedules reconnect, or fires 'connection_dead' if reconnect limit is hit
			 */
			if (this._reconnect_attempt < this.reconnect_limit) {
					var timeout = Math.pow(2, this._reconnect_attempt);
					console.log("Connection lost, reconnecting in " + timeout + " seconds.");
					setTimeout($.proxy(this.reconnect, this), 1e3 * timeout);
			} else {
					this.events.trigger('kernel_connection_dead.Kernel', {
							kernel: this,
							reconnect_attempt: this._reconnect_attempt,
					});
					console.log("Failed to reconnect, giving up.");
			}
	};

	Kernel.prototype.stop_channels = function () {
			/**
			 * Close the websocket. After successful close, the value
			 * in `this.ws` will be null.
			 *
			 * @function stop_channels
			 */
			var that = this;
			var close = function () {
					if (that.ws && that.ws.readyState === WebSocket.CLOSED) {
							that.ws = null;
					}
			};
			if (this.ws !== null) {
					if (this.ws.readyState === WebSocket.OPEN) {
							this.ws.onclose = close;
							this.ws.close();
					} else {
							close();
					}
			}
	};

	Kernel.prototype.is_connected = function () {
			/**
			 * Check whether there is a connection to the kernel. This
			 * function only returns true if websocket has been
			 * created and has a state of WebSocket.OPEN.
			 *
			 * @function is_connected
			 * @returns {bool} - whether there is a connection
			 */
			// if any channel is not ready, then we're not connected
			if (this.ws === null) {
					return false;
			}
			if (this.ws.readyState !== WebSocket.OPEN) {
					return false;
			}
			return true;
	};

	Kernel.prototype.is_fully_disconnected = function () {
			/**
			 * Check whether the connection to the kernel has been completely
			 * severed. This function only returns true if all channel objects
			 * are null.
			 *
			 * @function is_fully_disconnected
			 * @returns {bool} - whether the kernel is fully disconnected
			 */
			return (this.ws === null);
	};

	Kernel.prototype.send_shell_message = function (msg_type, content, callbacks, metadata, buffers) {
			/**
			 * Send a message on the Kernel's shell channel
			 *
			 * @function send_shell_message
			 */
			if (!this.is_connected()) {
					throw new Error("kernel is not connected");
			}
			var msg = this._get_msg(msg_type, content, metadata, buffers);
			msg.channel = 'shell';
			this.ws.send(serialize.serialize(msg));
			this.set_callbacks_for_msg(msg.header.msg_id, callbacks);
			return msg.header.msg_id;
	};

	Kernel.prototype.kernel_info = function (callback) {
			/**
			 * Get kernel info
			 *
			 * @function kernel_info
			 * @param callback {function}
			 *
			 * When calling this method, pass a callback function that expects one argument.
			 * The callback will be passed the complete `kernel_info_reply` message documented
			 * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#kernel-info)
			 */
			var callbacks;
			if (callback) {
					callbacks = { shell : { reply : callback } };
			}
			return this.send_shell_message("kernel_info_request", {}, callbacks);
	};

	Kernel.prototype.inspect = function (code, cursor_pos, callback) {
			/**
			 * Get info on an object
			 *
			 * When calling this method, pass a callback function that expects one argument.
			 * The callback will be passed the complete `inspect_reply` message documented
			 * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#object-information)
			 *
			 * @function inspect
			 * @param code {string}
			 * @param cursor_pos {integer}
			 * @param callback {function}
			 */
			var callbacks;
			if (callback) {
					callbacks = { shell : { reply : callback } };
			}

			var content = {
					code : code,
					cursor_pos : cursor_pos,
					detail_level : 0
			};
			return this.send_shell_message("inspect_request", content, callbacks);
	};

	Kernel.prototype.execute = function (code, callbacks, options) {
			/**
			 * Execute given code into kernel, and pass result to callback.
			 *
			 * @async
			 * @function execute
			 * @param {string} code
			 * @param [callbacks] {Object} With the following keys (all optional)
			 *      @param callbacks.shell.reply {function}
			 *      @param callbacks.shell.payload.[payload_name] {function}
			 *      @param callbacks.iopub.output {function}
			 *      @param callbacks.iopub.clear_output {function}
			 *      @param callbacks.input {function}
			 * @param {object} [options]
			 *      @param [options.silent=false] {Boolean}
			 *      @param [options.user_expressions=empty_dict] {Dict}
			 *      @param [options.allow_stdin=false] {Boolean} true|false
			 *
			 * @example
			 *
			 * The options object should contain the options for the execute
			 * call. Its default values are:
			 *
			 *      options = {
			 *        silent : true,
			 *        user_expressions : {},
			 *        allow_stdin : false
			 *      }
			 *
			 * When calling this method pass a callbacks structure of the
			 * form:
			 *
			 *      callbacks = {
			 *       shell : {
			 *         reply : execute_reply_callback,
			 *         payload : {
			 *           set_next_input : set_next_input_callback,
			 *         }
			 *       },
			 *       iopub : {
			 *         output : output_callback,
			 *         clear_output : clear_output_callback,
			 *       },
			 *       input : raw_input_callback
			 *      }
			 *
			 * Each callback will be passed the entire message as a single
			 * arugment.  Payload handlers will be passed the corresponding
			 * payload and the execute_reply message.
			 */
			var content = {
					code : code,
					silent : true,
					store_history : false,
					user_expressions : {},
					allow_stdin : false
			};
			callbacks = callbacks || {};
			if (callbacks.input !== undefined) {
					content.allow_stdin = true;
			}
			$.extend(true, content, options);
			this.events.trigger('execution_request.Kernel', {kernel: this, content: content});
			return this.send_shell_message("execute_request", content, callbacks);
	};

	/**
	 * When calling this method, pass a function to be called with the
	 * `complete_reply` message as its only argument when it arrives.
	 *
	 * `complete_reply` is documented
	 * [here](http://ipython.org/ipython-doc/dev/development/messaging.html#complete)
	 *
	 * @function complete
	 * @param code {string}
	 * @param cursor_pos {integer}
	 * @param callback {function}
	 */
	Kernel.prototype.complete = function (code, cursor_pos, callback) {
			var callbacks;
			if (callback) {
					callbacks = { shell : { reply : callback } };
			}
			var content = {
					code : code,
					cursor_pos : cursor_pos
			};
			return this.send_shell_message("complete_request", content, callbacks);
	};

	/**
	 * @function send_input_reply
	 */
	Kernel.prototype.send_input_reply = function (input) {
			if (!this.is_connected()) {
					throw new Error("kernel is not connected");
			}
			var content = {
					value : input
			};
			this.events.trigger('input_reply.Kernel', {kernel: this, content: content});
			var msg = this._get_msg("input_reply", content);
			msg.channel = 'stdin';
			this.ws.send(serialize.serialize(msg));
			return msg.header.msg_id;
	};

	/**
	 * @function register_iopub_handler
	 */
	Kernel.prototype.register_iopub_handler = function (msg_type, callback) {
			this._iopub_handlers[msg_type] = callback;
	};

	/**
	 * Get the iopub handler for a specific message type.
	 *
	 * @function get_iopub_handler
	 */
	Kernel.prototype.get_iopub_handler = function (msg_type) {
			return this._iopub_handlers[msg_type];
	};

	/**
	 * Get callbacks for a specific message.
	 *
	 * @function get_callbacks_for_msg
	 */
	Kernel.prototype.get_callbacks_for_msg = function (msg_id) {
			if (msg_id == this.last_msg_id) {
					return this.last_msg_callbacks;
			} else {
					return this._msg_callbacks[msg_id];
			}
	};

	/**
	 * Clear callbacks for a specific message.
	 *
	 * @function clear_callbacks_for_msg
	 */
	Kernel.prototype.clear_callbacks_for_msg = function (msg_id) {
			if (this._msg_callbacks[msg_id] !== undefined ) {
					delete this._msg_callbacks[msg_id];
			}
	};

	/**
	 * @function _finish_shell
	 */
	Kernel.prototype._finish_shell = function (msg_id) {
			var callbacks = this._msg_callbacks[msg_id];
			if (callbacks !== undefined) {
					callbacks.shell_done = true;
					if (callbacks.iopub_done) {
							this.clear_callbacks_for_msg(msg_id);
					}
			}
	};

	/**
	 * @function _finish_iopub
	 */
	Kernel.prototype._finish_iopub = function (msg_id) {
			var callbacks = this._msg_callbacks[msg_id];
			if (callbacks !== undefined) {
					callbacks.iopub_done = true;
					if (callbacks.shell_done) {
							this.clear_callbacks_for_msg(msg_id);
					}
			}
	};

	/**
	 * Set callbacks for a particular message.
	 * Callbacks should be a struct of the following form:
	 * shell : {
	 *
	 * }
	 *
	 * @function set_callbacks_for_msg
	 */
	Kernel.prototype.set_callbacks_for_msg = function (msg_id, callbacks) {
			this.last_msg_id = msg_id;
			if (callbacks) {
					// shallow-copy mapping, because we will modify it at the top level
					var cbcopy = this._msg_callbacks[msg_id] = this.last_msg_callbacks = {};
					cbcopy.shell = callbacks.shell;
					cbcopy.iopub = callbacks.iopub;
					cbcopy.input = callbacks.input;
					cbcopy.shell_done = (!callbacks.shell);
					cbcopy.iopub_done = (!callbacks.iopub);
			} else {
					this.last_msg_callbacks = {};
			}
	};

	Kernel.prototype._handle_ws_message = function (e) {
			var that = this;
			this._msg_queue = this._msg_queue.then(function() {
					return serialize.deserialize(e.data);
			}).then(function(msg) {return that._finish_ws_message(msg);})
			.catch(utils.reject("Couldn't process kernel message", true));
	};

	Kernel.prototype._finish_ws_message = function (msg) {
			switch (msg.channel) {
					case 'shell':
							return this._handle_shell_reply(msg);
							break;
					case 'iopub':
							return this._handle_iopub_message(msg);
							break;
					case 'stdin':
							return this._handle_input_request(msg);
							break;
					default:
							console.error("unrecognized message channel", msg.channel, msg);
			}
	};

	Kernel.prototype._handle_shell_reply = function (reply) {
			this.events.trigger('shell_reply.Kernel', {kernel: this, reply:reply});
			var that = this;
			var content = reply.content;
			var metadata = reply.metadata;
			var parent_id = reply.parent_header.msg_id;
			var callbacks = this.get_callbacks_for_msg(parent_id);
			var promise = Promise.resolve();
			if (!callbacks || !callbacks.shell) {
					return;
			}
			var shell_callbacks = callbacks.shell;

			// signal that shell callbacks are done
			this._finish_shell(parent_id);

			if (shell_callbacks.reply !== undefined) {
					promise = promise.then(function() {return shell_callbacks.reply(reply)});
			}
			if (content.payload && shell_callbacks.payload) {
					promise = promise.then(function() {
							return that._handle_payloads(content.payload, shell_callbacks.payload, reply);
					});
			}
			return promise;
	};

	/**
	 * @function _handle_payloads
	 */
	Kernel.prototype._handle_payloads = function (payloads, payload_callbacks, msg) {
			var promise = [];
			var l = payloads.length;
			// Payloads are handled by triggering events because we don't want the Kernel
			// to depend on the Notebook or Pager classes.
			for (var i=0; i<l; i++) {
					var payload = payloads[i];
					var callback = payload_callbacks[payload.source];
					if (callback) {
							promise.push(callback(payload, msg));
					}
			}
			return Promise.all(promise);
	};

	/**
	 * @function _handle_status_message
	 */
	Kernel.prototype._handle_status_message = function (msg) {
			var execution_state = msg.content.execution_state;
			var parent_id = msg.parent_header.msg_id;

			// dispatch status msg callbacks, if any
			var callbacks = this.get_callbacks_for_msg(parent_id);
			if (callbacks && callbacks.iopub && callbacks.iopub.status) {
					try {
							callbacks.iopub.status(msg);
					} catch (e) {
							console.log("Exception in status msg handler", e, e.stack);
					}
			}

			if (execution_state === 'busy') {
					this.events.trigger('kernel_busy.Kernel', {kernel: this});

			} else if (execution_state === 'idle') {
					// signal that iopub callbacks are (probably) done
					// async output may still arrive,
					// but only for the most recent request
					this._finish_iopub(parent_id);

					// trigger status_idle event
					this.events.trigger('kernel_idle.Kernel', {kernel: this});

			} else if (execution_state === 'starting') {
					this.events.trigger('kernel_starting.Kernel', {kernel: this});
					var that = this;
					this.kernel_info(function (reply) {
							that.info_reply = reply.content;
							that.events.trigger('kernel_ready.Kernel', {kernel: that});
					});

			} else if (execution_state === 'restarting') {
					// autorestarting is distinct from restarting,
					// in that it means the kernel died and the server is restarting it.
					// kernel_restarting sets the notification widget,
					// autorestart shows the more prominent dialog.
					this._autorestart_attempt = this._autorestart_attempt + 1;
					this.events.trigger('kernel_restarting.Kernel', {kernel: this});
					this.events.trigger('kernel_autorestarting.Kernel', {kernel: this, attempt: this._autorestart_attempt});

			} else if (execution_state === 'dead') {
					this.events.trigger('kernel_dead.Kernel', {kernel: this});
					this._kernel_dead();
			}
	};

	/**
	 * Handle clear_output message
	 *
	 * @function _handle_clear_output
	 */
	Kernel.prototype._handle_clear_output = function (msg) {
			var callbacks = this.get_callbacks_for_msg(msg.parent_header.msg_id);
			if (!callbacks || !callbacks.iopub) {
					return;
			}
			var callback = callbacks.iopub.clear_output;
			if (callback) {
					callback(msg);
			}
	};

	/**
	 * handle an output message (execute_result, display_data, etc.)
	 *
	 * @function _handle_output_message
	 */
	Kernel.prototype._handle_output_message = function (msg) {
			var callbacks = this.get_callbacks_for_msg(msg.parent_header.msg_id);
			if (!callbacks || !callbacks.iopub) {
					// The message came from another client. Let the UI decide what to
					// do with it.
					this.events.trigger('received_unsolicited_message.Kernel', msg);
					return;
			}
			var callback = callbacks.iopub.output;
			if (callback) {
					callback(msg);
			}
	};

	/**
	 * Handle an input message (execute_input).
	 *
	 * @function _handle_input message
	 */
	Kernel.prototype._handle_input_message = function (msg) {
			var callbacks = this.get_callbacks_for_msg(msg.parent_header.msg_id);
			if (!callbacks) {
					// The message came from another client. Let the UI decide what to
					// do with it.
					this.events.trigger('received_unsolicited_message.Kernel', msg);
			}
	};

	/**
	 * Dispatch IOPub messages to respective handlers. Each message
	 * type should have a handler.
	 *
	 * @function _handle_iopub_message
	 */
	Kernel.prototype._handle_iopub_message = function (msg) {
			var handler = this.get_iopub_handler(msg.header.msg_type);
			if (handler !== undefined) {
					return handler(msg);
			}
	};

	/**
	 * @function _handle_input_request
	 */
	Kernel.prototype._handle_input_request = function (request) {
			var header = request.header;
			var content = request.content;
			var metadata = request.metadata;
			var msg_type = header.msg_type;
			if (msg_type !== 'input_request') {
					console.log("Invalid input request!", request);
					return;
			}
			var callbacks = this.get_callbacks_for_msg(request.parent_header.msg_id);
			if (callbacks) {
					if (callbacks.input) {
							callbacks.input(request);
					}
			}
	};

	return {'Kernel': Kernel};
})();

// services/sessions/session
var servicesSessionsSession = (function servicesSessionsSession() {
	"use strict";

	var utils = baseJsUtils;
	var kernel = servicesKernelsKernel;

	/**
	 * Session object for accessing the session REST api. The session
	 * should be used to start kernels and then shut them down -- for
	 * all other operations, the kernel object should be used.
	 *
	 * Preliminary documentation for the REST API is at
	 * https://github.com/ipython/ipython/wiki/IPEP-16%3A-Notebook-multi-directory-dashboard-and-URL-mapping#sessions-api
	 *
	 * Options should include:
	 *  - notebook_path: the path (not including name) to the notebook
	 *  - kernel_name: the type of kernel (e.g. python3)
	 *  - base_url: the root url of the notebook server
	 *  - ws_url: the url to access websockets
	 *  - notebook: Notebook object
	 *
	 * @class Session
	 * @param {Object} options
	 */
	var Session = function (options) {
			this.id = null;
			this.notebook_model = {
					path: options.notebook_path
			};
			this.kernel_model = {
					id: null,
					name: options.kernel_name
			};

			this.base_url = options.base_url;
			this.ws_url = options.ws_url;
			this.session_service_url = utils.url_join_encode(this.base_url, 'api/sessions');
			this.session_url = null;

			this.notebook = options.notebook;
			this.kernel = null;
			this.events = options.notebook.events;

			this.bind_events();
	};

	Session.prototype.bind_events = function () {
			var that = this;
			var record_status = function (evt, info) {
					console.log('Session: ' + evt.type + ' (' + info.session.id + ')');
			};

			this.events.on('kernel_created.Session', record_status);
			this.events.on('kernel_dead.Session', record_status);
			this.events.on('kernel_killed.Session', record_status);

			// if the kernel dies, then also remove the session
			this.events.on('kernel_dead.Kernel', function () {
					that.delete();
			});
	};


	// Public REST api functions

	/**
	 * GET /api/sessions
	 *
	 * Get a list of the current sessions.
	 *
	 * @function list
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.list = function (success, error) {
			$.ajax(this.session_service_url, {
					processData: false,
					cache: false,
					type: "GET",
					dataType: "json",
					success: success,
					error: this._on_error(error)
			});
	};

	/**
	 * POST /api/sessions
	 *
	 * Start a new session. This function can only executed once.
	 *
	 * @function start
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.start = function (success, error) {
			var that = this;
			var on_success = function (data, status, xhr) {
					if (that.kernel) {
							that.kernel.name = that.kernel_model.name;
					} else {
							var kernel_service_url = utils.url_path_join(that.base_url, "api/kernels");
							that.kernel = new kernel.Kernel(kernel_service_url, that.ws_url, that.kernel_model.name);
					}
					that.events.trigger('kernel_created.Session', {session: that, kernel: that.kernel});
					that.kernel._kernel_created(data.kernel);
					if (success) {
							success(data, status, xhr);
					}
			};
			var on_error = function (xhr, status, err) {
					that.events.trigger('kernel_dead.Session', {session: that, xhr: xhr, status: status, error: err});
					if (error) {
							error(xhr, status, err);
					}
			};

			$.ajax(this.session_service_url, {
					processData: false,
					cache: false,
					type: "POST",
					data: JSON.stringify(this._get_model()),
					contentType: 'application/json',
					dataType: "json",
					success: this._on_success(on_success),
					error: this._on_error(on_error)
			});
	};

	/**
	 * GET /api/sessions/[:session_id]
	 *
	 * Get information about a session.
	 *
	 * @function get_info
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.get_info = function (success, error) {
			$.ajax(this.session_url, {
					processData: false,
					cache: false,
					type: "GET",
					dataType: "json",
					success: this._on_success(success),
					error: this._on_error(error)
			});
	};

	/**
	 * PATCH /api/sessions/[:session_id]
	 *
	 * Rename or move a notebook. If the given name or path are
	 * undefined, then they will not be changed.
	 *
	 * @function rename_notebook
	 * @param {string} [path] - new notebook path
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.rename_notebook = function (path, success, error) {
			if (path !== undefined) {
					this.notebook_model.path = path;
			}

			$.ajax(this.session_url, {
					processData: false,
					cache: false,
					type: "PATCH",
					data: JSON.stringify(this._get_model()),
					contentType: 'application/json',
					dataType: "json",
					success: this._on_success(success),
					error: this._on_error(error)
			});
	};

	/**
	 * DELETE /api/sessions/[:session_id]
	 *
	 * Kill the kernel and shutdown the session.
	 *
	 * @function delete
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.delete = function (success, error) {
			if (this.kernel) {
					this.events.trigger('kernel_killed.Session', {session: this, kernel: this.kernel});
					this.kernel._kernel_dead();
			}

			$.ajax(this.session_url, {
					processData: false,
					cache: false,
					type: "DELETE",
					dataType: "json",
					success: this._on_success(success),
					error: this._on_error(error)
			});
	};

	/**
	 * Restart the session by deleting it and the starting it
	 * fresh. If options are given, they can include any of the
	 * following:
	 *
	 * - notebook_path - the path to the notebook
	 * - kernel_name - the name (type) of the kernel
	 *
	 * @function restart
	 * @param {Object} [options] - options for the new kernel
	 * @param {function} [success] - function executed on ajax success
	 * @param {function} [error] - functon executed on ajax error
	 */
	Session.prototype.restart = function (options, success, error) {
			var that = this;
			var start = function () {
					if (options && options.notebook_path) {
							that.notebook_model.path = options.notebook_path;
					}
					if (options && options.kernel_name) {
							that.kernel_model.name = options.kernel_name;
					}
					that.kernel_model.id = null;
					that.start(success, error);
			};
			this.delete(start, start);
	};

	// Helper functions

	/**
	 * Get the data model for the session, which includes the notebook path
	 * and kernel (name and id).
	 *
	 * @function _get_model
	 * @returns {Object} - the data model
	 */
	Session.prototype._get_model = function () {
			return {
					notebook: this.notebook_model,
					kernel: this.kernel_model
			};
	};

	/**
	 * Update the data model from the given JSON object, which should
	 * have attributes of `id`, `notebook`, and/or `kernel`. If
	 * provided, the notebook data must include name and path, and the
	 * kernel data must include name and id.
	 *
	 * @function _update_model
	 * @param {Object} data - updated data model
	 */
	Session.prototype._update_model = function (data) {
			if (data && data.id) {
					this.id = data.id;
					this.session_url = utils.url_join_encode(this.session_service_url, this.id);
			}
			if (data && data.notebook) {
					this.notebook_model.path = data.notebook.path;
			}
			if (data && data.kernel) {
					this.kernel_model.name = data.kernel.name;
					this.kernel_model.id = data.kernel.id;
			}
	};

	/**
	 * Handle a successful AJAX request by updating the session data
	 * model with the response, and then optionally calling a provided
	 * callback.
	 *
	 * @function _on_success
	 * @param {function} success - callback
	 */
	Session.prototype._on_success = function (success) {
			var that = this;
			return function (data, status, xhr) {
					that._update_model(data);
					if (success) {
							success(data, status, xhr);
					}
			};
	};

	/**
	 * Handle a failed AJAX request by logging the error message, and
	 * then optionally calling a provided callback.
	 *
	 * @function _on_error
	 * @param {function} error - callback
	 */
	Session.prototype._on_error = function (error) {
			return function (xhr, status, err) {
					utils.log_ajax_error(xhr, status, err);
					if (error) {
							error(xhr, status, err);
					}
			};
	};

	/**
	 * Error type indicating that the session is already starting.
	 */
	var SessionAlreadyStarting = function (message) {
			this.name = "SessionAlreadyStarting";
			this.message = (message || "");
	};

	SessionAlreadyStarting.prototype = Error.prototype;

	return {
			Session: Session,
			SessionAlreadyStarting: SessionAlreadyStarting
	};
})();

// codemirror/addon/runmode/runmode
(function(mod) {
	mod(CodeMirror)
})(function(Codemiror) {
	"use strict";
	
	CodeMirror.runMode = function(string, modespec, callback, options) {
		var mode = CodeMirror.getMode(CodeMirror.defaults, modespec);
		var ie = /MSIE \d/.test(navigator.userAgent);
		var ie_lt9 = ie && (document.documentMode == null || document.documentMode < 9);
	
		if (callback.nodeType == 1) {
			var tabSize = (options && options.tabSize) || CodeMirror.defaults.tabSize;
			var node = callback, col = 0;
			node.innerHTML = "";
			callback = function(text, style) {
				if (text == "\n") {
					// Emitting LF or CRLF on IE8 or earlier results in an incorrect display.
					// Emitting a carriage return makes everything ok.
					node.appendChild(document.createTextNode(ie_lt9 ? '\r' : text));
					col = 0;
					return;
				}
				var content = "";
				// replace tabs
				for (var pos = 0;;) {
					var idx = text.indexOf("\t", pos);
					if (idx == -1) {
						content += text.slice(pos);
						col += text.length - pos;
						break;
					} else {
						col += idx - pos;
						content += text.slice(pos, idx);
						var size = tabSize - col % tabSize;
						col += size;
						for (var i = 0; i < size; ++i) content += " ";
						pos = idx + 1;
					}
				}
	
				if (style) {
					var sp = node.appendChild(document.createElement("span"));
					sp.className = "cm-" + style.replace(/ +/g, " cm-");
					sp.appendChild(document.createTextNode(content));
				} else {
					node.appendChild(document.createTextNode(content));
				}
			};
		}
	
		var lines = CodeMirror.splitLines(string), state = (options && options.state) || CodeMirror.startState(mode);
		for (var i = 0, e = lines.length; i < e; ++i) {
			if (i) callback("\n");
			var stream = new CodeMirror.StringStream(lines[i]);
			if (!stream.string && mode.blankLine) mode.blankLine(state);
			while (!stream.eol()) {
				var style = mode.token(stream, state);
				callback(stream.current(), style, i, stream.start, state);
				stream.start = stream.pos;
			}
		}
	};
});

// notebook/js/tooltip
var notebookJsTooltip = (function notebookJsTooltip() {
	"use strict";

	var utils = baseJsUtils;

	// tooltip constructor
	var Tooltip = function (events) {
			var that = this;
			this.events = events;
			this.time_before_tooltip = 1200;

			// handle to html
			this.tooltip = $('#tooltip');
			this._hidden = true;

			// variable for consecutive call
			this._old_cell = null;
			this._old_request = null;
			this._consecutive_counter = 0;

			// 'sticky ?'
			this._sticky = false;

			// display tooltip if the docstring is empty?
			this._hide_if_no_docstring = false;

			// contain the button in the upper right corner
			this.buttons = $('<div/>').addClass('tooltipbuttons');

			// will contain the docstring
			this.text = $('<div/>').addClass('tooltiptext').addClass('smalltooltip');

			// build the buttons menu on the upper right
			// expand the tooltip to see more
			var expandlink = $('<a/>').attr('href', "#").addClass("ui-corner-all") //rounded corner
			.attr('role', "button").attr('id', 'expanbutton').attr('title', 'Grow the tooltip vertically (press shift-tab twice)').click(function () {
					that.expand();
					event.preventDefault();
			}).append(
			$('<span/>').text('Expand').addClass('ui-icon').addClass('ui-icon-plus'));

			// open in pager
			var morelink = $('<a/>').attr('href', "#").attr('role', "button").addClass('ui-button').attr('title', 'show the current docstring in pager (press shift-tab 4 times)');
			var morespan = $('<span/>').text('Open in Pager').addClass('ui-icon').addClass('ui-icon-arrowstop-l-n');
			morelink.append(morespan);
			morelink.click(function () {
					that.showInPager(that._old_cell);
					event.preventDefault();
			});

			// close the tooltip
			var closelink = $('<a/>').attr('href', "#").attr('role', "button").addClass('ui-button');
			var closespan = $('<span/>').text('Close').addClass('ui-icon').addClass('ui-icon-close');
			closelink.append(closespan);
			closelink.click(function () {
					that.remove_and_cancel_tooltip(true);
					event.preventDefault();
			});

			this._clocklink = $('<a/>').attr('href', "#");
			this._clocklink.attr('role', "button");
			this._clocklink.addClass('ui-button');
			this._clocklink.attr('title', 'Tooltip will linger for 10 seconds while you type');
			var clockspan = $('<span/>').text('Close');
			clockspan.addClass('ui-icon');
			clockspan.addClass('ui-icon-clock');
			this._clocklink.append(clockspan);
			this._clocklink.click(function () {
					that.cancel_stick();
					event.preventDefault();
			});




			//construct the tooltip
			// add in the reverse order you want them to appear
			this.buttons.append(closelink);
			this.buttons.append(expandlink);
			this.buttons.append(morelink);
			this.buttons.append(this._clocklink);
			this._clocklink.hide();


			// we need a phony element to make the small arrow
			// of the tooltip in css
			// we will move the arrow later
			this.arrow = $('<div/>').addClass('pretooltiparrow');
			this.tooltip.append(this.buttons);
			this.tooltip.append(this.arrow);
			this.tooltip.append(this.text);

			// function that will be called if you press tab 1, 2, 3... times in a row
			this.tabs_functions = [function (cell, text, cursor) {
					that._request_tooltip(cell, text, cursor);
			}, function () {
					that.expand();
			}, function () {
					that.stick();
			}, function (cell) {
					that.cancel_stick();
					that.showInPager(cell);
			}];
			// call after all the tabs function above have bee call to clean their effects
			// if necessary
			this.reset_tabs_function = function (cell, text) {
					this._old_cell = (cell) ? cell : null;
					this._old_request = (text) ? text : null;
					this._consecutive_counter = 0;
			};
	};

	Tooltip.prototype.is_visible = function () {
			return !this._hidden;
	};

	Tooltip.prototype.showInPager = function (cell) {
			/**
			 * reexecute last call in pager by appending ? to show back in pager
			 */
			this.events.trigger('open_with_text.Pager', this._reply.content);
			this.remove_and_cancel_tooltip();
	};

	// grow the tooltip verticaly
	Tooltip.prototype.expand = function () {
			this.text.removeClass('smalltooltip');
			this.text.addClass('bigtooltip');
			$('#expanbutton').hide('slow');
	};

	// deal with all the logic of hiding the tooltip
	// and reset it's status
	Tooltip.prototype._hide = function () {
			this._hidden = true;
			this.tooltip.fadeOut('fast');
			$('#expanbutton').show('slow');
			this.text.removeClass('bigtooltip');
			this.text.addClass('smalltooltip');
			// keep scroll top to be sure to always see the first line
			this.text.scrollTop(0);
			this.code_mirror = null;
	};

	// return true on successfully removing a visible tooltip; otherwise return
	// false.
	Tooltip.prototype.remove_and_cancel_tooltip = function (force) {
			/**
			 * note that we don't handle closing directly inside the calltip
			 * as in the completer, because it is not focusable, so won't
			 * get the event.
			 */
			this.cancel_pending();
			if (!this._hidden) {
				if (force || !this._sticky) {
						this.cancel_stick();
						this._hide();
				}
				this.reset_tabs_function();
				return true;
			} else {
				return false;
			}
	};

	// cancel autocall done after '(' for example.
	Tooltip.prototype.cancel_pending = function () {
			if (this._tooltip_timeout !== null) {
					clearTimeout(this._tooltip_timeout);
					this._tooltip_timeout = null;
			}
	};

	// will trigger tooltip after timeout
	Tooltip.prototype.pending = function (cell, hide_if_no_docstring) {
			var that = this;
			this._tooltip_timeout = setTimeout(function () {
					that.request(cell, hide_if_no_docstring);
			}, that.time_before_tooltip);
	};

	// easy access for julia monkey patching.
	Tooltip.last_token_re = /[a-z_][0-9a-z._]*$/gi;

	Tooltip.prototype._request_tooltip = function (cell, text, cursor_pos) {
			var callbacks = $.proxy(this._show, this);
			var msg_id = cell.kernel.inspect(text, cursor_pos, callbacks);
	};

	// make an immediate completion request
	Tooltip.prototype.request = function (cell, hide_if_no_docstring) {
			/**
			 * request(codecell)
			 * Deal with extracting the text from the cell and counting
			 * call in a row
			 */
			this.cancel_pending();
			var editor = cell.code_mirror;
			var cursor = editor.getCursor();
			var cursor_pos = utils.to_absolute_cursor_pos(editor, cursor);
			var text = cell.get_text();

			this._hide_if_no_docstring = hide_if_no_docstring;

			if(editor.somethingSelected()){
					// get only the most recent selection.
					text = editor.getSelection();
			}

			// need a permanent handle to code_mirror for future auto recall
			this.code_mirror = editor;

			// now we treat the different number of keypress
			// first if same cell, same text, increment counter by 1
			if (this._old_cell == cell && this._old_request == text && this._hidden === false) {
					this._consecutive_counter++;
			} else {
					// else reset
					this.cancel_stick();
					this.reset_tabs_function (cell, text);
			}

			this.tabs_functions[this._consecutive_counter](cell, text, cursor_pos);

			// then if we are at the end of list function, reset
			if (this._consecutive_counter == this.tabs_functions.length) {
					this.reset_tabs_function (cell, text, cursor);
			}

			return;
	};

	// cancel the option of having the tooltip to stick
	Tooltip.prototype.cancel_stick = function () {
			clearTimeout(this._stick_timeout);
			this._stick_timeout = null;
			this._clocklink.hide('slow');
			this._sticky = false;
	};

	// put the tooltip in a sicky state for 10 seconds
	// it won't be removed by remove_and_cancell() unless you called with
	// the first parameter set to true.
	// remove_and_cancell_tooltip(true)
	Tooltip.prototype.stick = function (time) {
			time = (time !== undefined) ? time : 10;
			var that = this;
			this._sticky = true;
			this._clocklink.show('slow');
			this._stick_timeout = setTimeout(function () {
					that._sticky = false;
					that._clocklink.hide('slow');
			}, time * 1000);
	};

	// should be called with the kernel reply to actually show the tooltip
	Tooltip.prototype._show = function (reply) {
			/**
			 * move the bubble if it is not hidden
			 * otherwise fade it
			 */
			this._reply = reply;
			var content = reply.content;
			if (!content.found) {
					// object not found, nothing to show
					return;
			}
			this.name = content.name;

			// do some math to have the tooltip arrow on more or less on left or right
			// position of the editor
			var cm_pos = $(this.code_mirror.getWrapperElement()).position();

			// anchor and head positions are local within CodeMirror element
			var anchor = this.code_mirror.cursorCoords(false, 'local');
			var head = this.code_mirror.cursorCoords(true, 'local');
			// locate the target at the center of anchor, head
			var center_left = (head.left + anchor.left) / 2;
			// locate the left edge of the tooltip, at most 450 px left of the arrow
			var edge_left = Math.max(center_left - 450, 0);
			// locate the arrow at the cursor. A 24 px offset seems necessary.
			var arrow_left = center_left - edge_left - 24;

			// locate left, top within container element
			var left = (cm_pos.left + edge_left) + 'px';
			var top = (cm_pos.top + head.bottom + 10) + 'px';

			if (this._hidden === false) {
					this.tooltip.animate({
							left: left,
							top: top
					});
			} else {
					this.tooltip.css({
							left: left
					});
					this.tooltip.css({
							top: top
					});
			}
			this.arrow.animate({
					'left': arrow_left + 'px'
			});

			this._hidden = false;
			this.tooltip.fadeIn('fast');
			this.text.children().remove();

			// This should support rich data types, but only text/plain for now
			// Any HTML within the docstring is escaped by the fixConsole() method.
			var pre = $('<pre/>').html(utils.fixConsole(content.data['text/plain']));
			this.text.append(pre);
			// keep scroll top to be sure to always see the first line
			this.text.scrollTop(0);
	};

	return {'Tooltip': Tooltip};
})();

// notebook/js/celltoolbarpresets/default
var notebookJsCellToolbarPresetsDefault = (function notebookJsCellToolbarPresetsDefault() {
	"use strict";

	var celltoolbar = notebookJsCelltoolbar;
	var dialog = baseJsDialog;

	var CellToolbar = celltoolbar.CellToolbar;

	var raw_edit = function (cell) {
			dialog.edit_metadata({
					md: cell.metadata,
					callback: function (md) {
							cell.metadata = md;
					},
					name: 'Cell',
					notebook: this.notebook,
					keyboard_manager: this.keyboard_manager
			});
	};

	var add_raw_edit_button = function(div, cell) {
			var button_container = $(div);
			var button = $('<button/>')
					.addClass("btn btn-default btn-xs")
					.text("Edit Metadata")
					.click( function () {
							raw_edit(cell);
							return false;
					});
			button_container.append(button);
	};

	var register = function (notebook) {
			CellToolbar.register_callback('default.rawedit', add_raw_edit_button);
			raw_edit = $.proxy(raw_edit, {
					notebook: notebook,
					keyboard_manager: notebook.keyboard_manager
			});

			var example_preset = [];
			example_preset.push('default.rawedit');

			CellToolbar.register_preset('Edit Metadata', example_preset, notebook);
			console.log('Default extension for cell metadata editing loaded.');
	};
	return {'register': register};
})();

// notebook/js/celltoolbarpresets/rawcell
var notebookJsCellToolbarPresetsRawcell = (function notebookJsCellToolbarPresetsRawcell() {
	"use strict";

	var celltoolbar = notebookJsCelltoolbar;
	var dialog = baseJsDialog;
	var keyboard = baseJsKeyboard;

	var CellToolbar = celltoolbar.CellToolbar;
	var raw_cell_preset = [];

	var select_type = CellToolbar.utils.select_ui_generator([
		["None", "-"],
		["LaTeX", "text/latex"],
		["reST", "text/restructuredtext"],
		["HTML", "text/html"],
		["Markdown", "text/markdown"],
		["Python", "text/x-python"],
		["Custom", "dialog"],

		],
		// setter
		function(cell, value) {
				if (value === "-") {
					delete cell.metadata.raw_mimetype;
				} else if (value === 'dialog'){
						var dialog = $('<div/>').append(
								$("<p/>")
										.text("Set the MIME type of the raw cell:")
						).append(
								$("<br/>")
						).append(
								$('<input/>').attr('type','text').attr('size','25')
								.val(cell.metadata.raw_mimetype || "-")
						);
						dialog.modal({
								title: "Raw Cell MIME Type",
								body: dialog,
								buttons : {
										"Cancel": {},
										"OK": {
												class: "btn-primary",
												click: function () {
														console.log(cell);
														cell.metadata.raw_mimetype = $(this).find('input').val();
														console.log(cell.metadata);
												}
										}
								},
								open : function (event, ui) {
										var that = $(this);
										// Upon ENTER, click the OK button.
										that.find('input[type="text"]').keydown(function (event, ui) {
												if (event.which === keyboard.keycodes.enter) {
														that.find('.btn-primary').first().click();
														return false;
												}
										});
										that.find('input[type="text"]').focus().select();
								}
						});
				} else {
					cell.metadata.raw_mimetype = value;
				}
			},
			//getter
			function(cell) {
				return cell.metadata.raw_mimetype || "";
			},
			// name
			"Raw NBConvert Format"
	);

	var register = function (notebook) {
		CellToolbar.register_callback('raw_cell.select', select_type, ['raw']);
		raw_cell_preset.push('raw_cell.select');

		CellToolbar.register_preset('Raw Cell Format', raw_cell_preset, notebook);
		console.log('Raw Cell Format toolbar preset loaded.');
	};
	return {'register': register};
})();

// notebook/js/celltoolbarpresets/slideshow
var notebookJsCellToolbarPresetsSlideshow = (function notebookJsCellToolbarPresetsSlideshow() {
	"use strict";

	var celltoolbar = notebookJsCelltoolbar;

	var CellToolbar = celltoolbar.CellToolbar;
	var slideshow_preset = [];

	var select_type = CellToolbar.utils.select_ui_generator([
					["-"            ,"-"            ],
					["Slide"        ,"slide"        ],
					["Sub-Slide"    ,"subslide"     ],
					["Fragment"     ,"fragment"     ],
					["Skip"         ,"skip"         ],
					["Notes"        ,"notes"        ],
					],
					// setter
					function(cell, value){
							// we check that the slideshow namespace exist and create it if needed
							if (cell.metadata.slideshow === undefined){cell.metadata.slideshow = {};}
							// set the value
							cell.metadata.slideshow.slide_type = value;
							},
					//geter
					function(cell){ var ns = cell.metadata.slideshow;
							// if the slideshow namespace does not exist return `undefined`
							// (will be interpreted as `false` by checkbox) otherwise
							// return the value
							return (ns === undefined)? undefined: ns.slide_type;
							},
					"Slide Type");

	var register = function (notebook) {
			CellToolbar.register_callback('slideshow.select',select_type);
			slideshow_preset.push('slideshow.select');

			CellToolbar.register_preset('Slideshow',slideshow_preset, notebook);
			console.log('Slideshow extension for metadata editing loaded.');
	};
	return {'register': register};
})();

// notebook/js/scrollmanager
var notebookJsScrollmanager = (function notebookJsScrollmanager() {
	"use strict";

	var ScrollManager = function(notebook, options) {
			/**
			 * Public constructor.
			 */
			this.notebook = notebook;
			this.element = $('#site');
			options = options || {};
			this.animation_speed = options.animation_speed || 250; //ms
	};

	ScrollManager.prototype.scroll = function (delta) {
			/**
			 * Scroll the document.
			 *
			 * Parameters
			 * ----------
			 * delta: integer
			 *  direction to scroll the document.  Positive is downwards.
			 *  Unit is one page length.
			 */
			this.scroll_some(delta);
			return false;
	};

	ScrollManager.prototype.scroll_to = function(selector) {
			/**
			 * Scroll to an element in the notebook.
			 */
			this.element.animate({'scrollTop': $(selector).offset().top + this.element.scrollTop() - this.element.offset().top}, this.animation_speed);
	};

	ScrollManager.prototype.scroll_some = function(pages) {
			/**
			 * Scroll up or down a given number of pages.
			 *
			 * Parameters
			 * ----------
			 * pages: integer
			 *  number of pages to scroll the document, may be positive or negative.
			 */
			this.element.animate({'scrollTop': this.element.scrollTop() + pages * this.element.height()}, this.animation_speed);
	};

	ScrollManager.prototype.get_first_visible_cell = function() {
			/**
			 * Gets the index of the first visible cell in the document.
			 *
			 * First, attempt to be smart by guessing the index of the cell we are
			 * scrolled to.  Then, walk from there up or down until the right cell
			 * is found.  To guess the index, get the top of the last cell, and
			 * divide that by the number of cells to get an average cell height.
			 * Then divide the scroll height by the average cell height.
			 */
			var cell_count = this.notebook.ncells();
			var first_cell_top = this.notebook.get_cell(0).element.offset().top;
			var last_cell_top = this.notebook.get_cell(cell_count-1).element.offset().top;
			var avg_cell_height = (last_cell_top - first_cell_top) / cell_count;
			var i = Math.ceil(this.element.scrollTop() / avg_cell_height);
			i = Math.min(Math.max(i , 0), cell_count - 1);

			while (this.notebook.get_cell(i).element.offset().top - first_cell_top < this.element.scrollTop() && i < cell_count - 1) {
					i += 1;
			}

			while (this.notebook.get_cell(i).element.offset().top - first_cell_top > this.element.scrollTop() - 50 && i >= 0) {
					i -= 1;
			}
			return Math.min(i + 1, cell_count - 1);
	};


	var TargetScrollManager = function(notebook, options) {
			/**
			 * Public constructor.
			 */
			ScrollManager.apply(this, [notebook, options]);
	};
	TargetScrollManager.prototype = Object.create(ScrollManager.prototype);

	TargetScrollManager.prototype.is_target = function (index) {
			/**
			 * Check if a cell should be a scroll stop.
			 *
			 * Returns `true` if the cell is a cell that the scroll manager
			 * should scroll to.  Otherwise, false is returned.
			 *
			 * Parameters
			 * ----------
			 * index: integer
			 *  index of the cell to test.
			 */
			return false;
	};

	TargetScrollManager.prototype.scroll = function (delta) {
			/**
			 * Scroll the document.
			 *
			 * Parameters
			 * ----------
			 * delta: integer
			 *  direction to scroll the document.  Positive is downwards.
			 *  Units are targets.
			 *
			 * Try to scroll to the next slide.
			 */
			var cell_count = this.notebook.ncells();
			var selected_index = this.get_first_visible_cell() + delta;
			while (0 <= selected_index && selected_index < cell_count && !this.is_target(selected_index)) {
					selected_index += delta;
			}

			if (selected_index < 0 || cell_count <= selected_index) {
					return ScrollManager.prototype.scroll.apply(this, [delta]);
			} else {
					this.scroll_to(this.notebook.get_cell(selected_index).element);

					// Cancel browser keyboard scroll.
					return false;
			}
	};


	var SlideScrollManager = function(notebook, options) {
			/**
			 * Public constructor.
			 */
			TargetScrollManager.apply(this, [notebook, options]);
	};
	SlideScrollManager.prototype = Object.create(TargetScrollManager.prototype);

	SlideScrollManager.prototype.is_target = function (index) {
			var cell = this.notebook.get_cell(index);
			return cell.metadata && cell.metadata.slideshow &&
					cell.metadata.slideshow.slide_type &&
					(cell.metadata.slideshow.slide_type === "slide" ||
					cell.metadata.slideshow.slide_type === "subslide");
	};


	var HeadingScrollManager = function(notebook, options) {
			/**
			 * Public constructor.
			 */
			ScrollManager.apply(this, [notebook, options]);
			options = options || {};
			this._level = options.heading_level || 1;
	};
	HeadingScrollManager.prototype = Object.create(ScrollManager.prototype);

	HeadingScrollManager.prototype.scroll = function (delta) {
			/**
			 * Scroll the document.
			 *
			 * Parameters
			 * ----------
			 * delta: integer
			 *  direction to scroll the document.  Positive is downwards.
			 *  Units are headers.
			 *
			 * Get all of the header elements that match the heading level or are of
			 * greater magnitude (a smaller header number).
			 */
			var headers = $();
			var i;
			for (i = 1; i <= this._level; i++) {
					headers = headers.add('#notebook-container h' + i);
			}

			// Find the header the user is on or below.
			var first_cell_top = this.notebook.get_cell(0).element.offset().top;
			var current_scroll = this.element.scrollTop();
			var header_scroll = 0;
			i = -1;
			while (current_scroll >= header_scroll && i < headers.length) {
					if (++i < headers.length) {
							header_scroll = $(headers[i]).offset().top - first_cell_top;
					}
			}
			i--;

			// Check if the user is below the header.
			if (i < 0 || current_scroll > $(headers[i]).offset().top - first_cell_top + 30) {
					// Below the header, count the header as a target.
					if (delta < 0) {
							delta += 1;
					}
			}
			i += delta;

			// Scroll!
			if (0 <= i && i < headers.length) {
					this.scroll_to(headers[i]);
					return false;
			} else {
					// Default to the base's scroll behavior when target header doesn't
					// exist.
					return ScrollManager.prototype.scroll.apply(this, [delta]);
			}
	};

	// Return naemspace for require.js loads
	return {
			'ScrollManager': ScrollManager,
			'SlideScrollManager': SlideScrollManager,
			'HeadingScrollManager': HeadingScrollManager,
			'TargetScrollManager': TargetScrollManager
	};
})();

// notebook/js/outputarea
var notebookJsOutputarea = (function notebookJsOutputarea() {
	"use strict";

	var utils = baseJsUtils;
	var security = baseJsSecurity;
	var keyboard = baseJsKeyboard;
	var mathjaxutils = notebookJsMathjaxutils;
	var marked = marked;

	/**
	 * @class OutputArea
	 *
	 * @constructor
	 */

	var OutputArea = function (options) {
			this.selector = options.selector;
			this.events = options.events;
			this.keyboard_manager = options.keyboard_manager;
			this.wrapper = $(options.selector);
			this.outputs = [];
			this.collapsed = false;
			this.scrolled = false;
			this.scroll_state = 'auto';
			this.trusted = true;
			this.clear_queued = null;
			if (options.prompt_area === undefined) {
					this.prompt_area = true;
			} else {
					this.prompt_area = options.prompt_area;
			}
			this.create_elements();
			this.style();
			this.bind_events();
	};


	/**
	 * Class prototypes
	 **/

	OutputArea.prototype.create_elements = function () {
			this.element = $("<div/>");
			this.collapse_button = $("<div/>");
			this.prompt_overlay = $("<div/>");
			this.wrapper.append(this.prompt_overlay);
			this.wrapper.append(this.element);
			this.wrapper.append(this.collapse_button);
	};


	OutputArea.prototype.style = function () {
			this.collapse_button.hide();
			this.prompt_overlay.hide();

			this.wrapper.addClass('output_wrapper');
			this.element.addClass('output');

			this.collapse_button.addClass("btn btn-default output_collapsed");
			this.collapse_button.attr('title', 'click to expand output');
			this.collapse_button.text('. . .');

			this.prompt_overlay.addClass('out_prompt_overlay prompt');
			this.prompt_overlay.attr('title', 'click to expand output; double click to hide output');

			this.collapse();
	};

	/**
	 * Should the OutputArea scroll?
	 * Returns whether the height (in lines) exceeds the current threshold.
	 * Threshold will be OutputArea.minimum_scroll_threshold if scroll_state=true (manually requested)
	 * or OutputArea.auto_scroll_threshold if scroll_state='auto'.
	 * This will always return false if scroll_state=false (scroll disabled).
	 *
	 */
	OutputArea.prototype._should_scroll = function () {
			var threshold;
			if (this.scroll_state === false) {
					return false;
			} else if (this.scroll_state === true) {
					threshold = OutputArea.minimum_scroll_threshold;
			} else {
					threshold = OutputArea.auto_scroll_threshold;
			}
			if (threshold <=0) {
					return false;
			}
			// line-height from http://stackoverflow.com/questions/1185151
			var fontSize = this.element.css('font-size');
			var lineHeight = Math.floor(parseInt(fontSize.replace('px','')) * 1.5);
			return (this.element.height() > threshold * lineHeight);
	};


	OutputArea.prototype.bind_events = function () {
			var that = this;
			this.prompt_overlay.dblclick(function () { that.toggle_output(); });
			this.prompt_overlay.click(function () { that.toggle_scroll(); });

			this.element.resize(function () {
					// FIXME: Firefox on Linux misbehaves, so automatic scrolling is disabled
					if ( utils.browser[0] === "Firefox" ) {
							return;
					}
					// maybe scroll output,
					// if it's grown large enough and hasn't already been scrolled.
					if (!that.scrolled && that._should_scroll()) {
							that.scroll_area();
					}
			});
			this.collapse_button.click(function () {
					that.expand();
			});
	};


	OutputArea.prototype.collapse = function () {
			if (!this.collapsed) {
					this.element.hide();
					this.prompt_overlay.hide();
					if (this.element.html()){
							this.collapse_button.show();
					}
					this.collapsed = true;
					// collapsing output clears scroll state
					this.scroll_state = 'auto';
			}
	};


	OutputArea.prototype.expand = function () {
			if (this.collapsed) {
					this.collapse_button.hide();
					this.element.show();
					if (this.prompt_area) {
							this.prompt_overlay.show();
					}
					this.collapsed = false;
					this.scroll_if_long();
			}
	};


	OutputArea.prototype.toggle_output = function () {
			if (this.collapsed) {
					this.expand();
			} else {
					this.collapse();
			}
	};


	OutputArea.prototype.scroll_area = function () {
			this.element.addClass('output_scroll');
			this.prompt_overlay.attr('title', 'click to unscroll output; double click to hide');
			this.scrolled = true;
	};


	OutputArea.prototype.unscroll_area = function () {
			this.element.removeClass('output_scroll');
			this.prompt_overlay.attr('title', 'click to scroll output; double click to hide');
			this.scrolled = false;
	};

	/**
	 * Scroll OutputArea if height exceeds a threshold.
	 *
	 * Threshold is OutputArea.minimum_scroll_threshold if scroll_state = true,
	 * OutputArea.auto_scroll_threshold if scroll_state='auto'.
	 *
	 **/
	OutputArea.prototype.scroll_if_long = function () {
			var should_scroll = this._should_scroll();
			if (!this.scrolled && should_scroll) {
					// only allow scrolling long-enough output
					this.scroll_area();
			} else if (this.scrolled && !should_scroll) {
					// scrolled and shouldn't be
					this.unscroll_area();
			}
	};


	OutputArea.prototype.toggle_scroll = function () {
			if (this.scroll_state == 'auto') {
					this.scroll_state = !this.scrolled;
			} else {
					this.scroll_state = !this.scroll_state;
			}
			if (this.scrolled) {
					this.unscroll_area();
			} else {
					// only allow scrolling long-enough output
					this.scroll_if_long();
			}
	};


	// typeset with MathJax if MathJax is available
	OutputArea.prototype.typeset = function () {
			utils.typeset(this.element);
	};


	OutputArea.prototype.handle_output = function (msg) {
			var json = {};
			var msg_type = json.output_type = msg.header.msg_type;
			var content = msg.content;
			if (msg_type === "stream") {
					json.text = content.text;
					json.name = content.name;
			} else if (msg_type === "display_data") {
					json.data = content.data;
					json.metadata = content.metadata;
			} else if (msg_type === "execute_result") {
					json.data = content.data;
					json.metadata = content.metadata;
					json.execution_count = content.execution_count;
			} else if (msg_type === "error") {
					json.ename = content.ename;
					json.evalue = content.evalue;
					json.traceback = content.traceback;
			} else {
					console.log("unhandled output message", msg);
					return;
			}
			this.append_output(json);
	};


	OutputArea.output_types = [
			'application/javascript',
			'text/html',
			'text/markdown',
			'text/latex',
			'image/svg+xml',
			'image/png',
			'image/jpeg',
			'application/pdf',
			'text/plain'
	];

	OutputArea.prototype.validate_mimebundle = function (bundle) {
			/** scrub invalid outputs */
			if (typeof bundle.data !== 'object') {
					console.warn("mimebundle missing data", bundle);
					bundle.data = {};
			}
			if (typeof bundle.metadata !== 'object') {
					console.warn("mimebundle missing metadata", bundle);
					bundle.metadata = {};
			}
			var data = bundle.data;
			$.map(OutputArea.output_types, function(key){
					data[key] = $.isArray(data[key]) ? data[key].join('') : data[key];

					if (key !== 'application/json' &&
							data[key] !== undefined &&
							typeof data[key] !== 'string'
					) {
							console.log("Invalid type for " + key, data[key]);
							delete data[key];
					}
			});
			return bundle;
	};

	OutputArea.prototype.append_output = function (json) {
			this.expand();

			// Clear the output if clear is queued.
			var needs_height_reset = false;
			if (this.clear_queued) {
					this.clear_output(false);
					needs_height_reset = true;
			}

			var record_output = true;
			switch(json.output_type) {
					case 'execute_result':
							json = this.validate_mimebundle(json);
							this.append_execute_result(json);
							break;
					case 'stream':
							// append_stream might have merged the output with earlier stream output
							record_output = this.append_stream(json);
							break;
					case 'error':
							this.append_error(json);
							break;
					case 'display_data':
							// append handled below
							json = this.validate_mimebundle(json);
							break;
					default:
							console.log("unrecognized output type: " + json.output_type);
							this.append_unrecognized(json);
			}

			// We must release the animation fixed height in a callback since Gecko
			// (FireFox) doesn't render the image immediately as the data is
			// available.
			var that = this;
			var handle_appended = function ($el) {
					/**
					 * Only reset the height to automatic if the height is currently
					 * fixed (done by wait=True flag on clear_output).
					 */
					if (needs_height_reset) {
							that.element.height('');
					}
					that.element.trigger('resize');
			};
			if (json.output_type === 'display_data') {
					this.append_display_data(json, handle_appended);
			} else {
					handle_appended();
			}

			if (record_output) {
					this.outputs.push(json);
			}
	};


	OutputArea.prototype.create_output_area = function () {
			var oa = $("<div/>").addClass("output_area");
			if (this.prompt_area) {
					oa.append($('<div/>').addClass('prompt'));
			}
			return oa;
	};


	function _get_metadata_key(metadata, key, mime) {
			var mime_md = metadata[mime];
			// mime-specific higher priority
			if (mime_md && mime_md[key] !== undefined) {
					return mime_md[key];
			}
			// fallback on global
			return metadata[key];
	}

	OutputArea.prototype.create_output_subarea = function(md, classes, mime) {
			var subarea = $('<div/>').addClass('output_subarea').addClass(classes);
			if (_get_metadata_key(md, 'isolated', mime)) {
					// Create an iframe to isolate the subarea from the rest of the
					// document
					var iframe = $('<iframe/>').addClass('box-flex1');
					iframe.css({'height':1, 'width':'100%', 'display':'block'});
					iframe.attr('frameborder', 0);
					iframe.attr('scrolling', 'auto');

					// Once the iframe is loaded, the subarea is dynamically inserted
					iframe.on('load', function() {
							// Workaround needed by Firefox, to properly render svg inside
							// iframes, see http://stackoverflow.com/questions/10177190/
							// svg-dynamically-added-to-iframe-does-not-render-correctly
							this.contentDocument.open();

							// Insert the subarea into the iframe
							// We must directly write the html. When using Jquery's append
							// method, javascript is evaluated in the parent document and
							// not in the iframe document.  At this point, subarea doesn't
							// contain any user content.
							this.contentDocument.write(subarea.html());

							this.contentDocument.close();

							var body = this.contentDocument.body;
							// Adjust the iframe height automatically
							iframe.height(body.scrollHeight + 'px');
					});

					// Elements should be appended to the inner subarea and not to the
					// iframe
					iframe.append = function(that) {
							subarea.append(that);
					};

					return iframe;
			} else {
					return subarea;
			}
	};


	OutputArea.prototype._append_javascript_error = function (err, element) {
			/**
			 * display a message when a javascript error occurs in display output
			 */
			var msg = "Javascript error adding output!";
			if ( element === undefined ) return;
			element
					.append($('<div/>').text(msg).addClass('js-error'))
					.append($('<div/>').text(err.toString()).addClass('js-error'))
					.append($('<div/>').text('See your browser Javascript console for more details.').addClass('js-error'));
	};

	OutputArea.prototype._safe_append = function (toinsert) {
			/**
			 * safely append an item to the document
			 * this is an object created by user code,
			 * and may have errors, which should not be raised
			 * under any circumstances.
			 */
			try {
					this.element.append(toinsert);
			} catch(err) {
					console.log(err);
					// Create an actual output_area and output_subarea, which creates
					// the prompt area and the proper indentation.
					var toinsert = this.create_output_area();
					var subarea = $('<div/>').addClass('output_subarea');
					toinsert.append(subarea);
					this._append_javascript_error(err, subarea);
					this.element.append(toinsert);
			}

			// Notify others of changes.
			this.element.trigger('changed');
	};


	OutputArea.prototype.append_execute_result = function (json) {
			var n = json.execution_count || ' ';
			var toinsert = this.create_output_area();
			if (this.prompt_area) {
					toinsert.find('div.prompt').addClass('output_prompt').text('Out[' + n + ']:');
			}
			var inserted = this.append_mime_type(json, toinsert);
			if (inserted) {
					inserted.addClass('output_result');
			}
			this._safe_append(toinsert);
			// If we just output latex, typeset it.
			if ((json.data['text/latex'] !== undefined) ||
					(json.data['text/html'] !== undefined) ||
					(json.data['text/markdown'] !== undefined)) {
					this.typeset();
			}
	};


	OutputArea.prototype.append_error = function (json) {
			var tb = json.traceback;
			if (tb !== undefined && tb.length > 0) {
					var s = '';
					var len = tb.length;
					for (var i=0; i<len; i++) {
							s = s + tb[i] + '\n';
					}
					s = s + '\n';
					var toinsert = this.create_output_area();
					var append_text = OutputArea.append_map['text/plain'];
					if (append_text) {
							append_text.apply(this, [s, {}, toinsert]).addClass('output_error');
					}
					this._safe_append(toinsert);
			}
	};


	OutputArea.prototype.append_stream = function (json) {
			var text = $.isArray(json.text) ? json.text.join('') : json.text;
			if (typeof text !== 'string') {
					console.error("Stream output is invalid (missing text)", json);
					return false;
			}
			var subclass = "output_"+json.name;
			if (this.outputs.length > 0){
					// have at least one output to consider
					var last = this.outputs[this.outputs.length-1];
					if (last.output_type == 'stream' && json.name == last.name){
							// latest output was in the same stream,
							// so append directly into its pre tag
							// escape ANSI & HTML specials:
							last.text = utils.fixCarriageReturn(last.text + json.text);
							var pre = this.element.find('div.'+subclass).last().find('pre');
							var html = utils.fixConsole(last.text);
							html = utils.autoLinkUrls(html);
							// The only user content injected with this HTML call is
							// escaped by the fixConsole() method.
							pre.html(html);
							// return false signals that we merged this output with the previous one,
							// and the new output shouldn't be recorded.
							return false;
					}
			}

			if (!text.replace("\r", "")) {
					// text is nothing (empty string, \r, etc.)
					// so don't append any elements, which might add undesirable space
					// return true to indicate the output should be recorded.
					return true;
			}

			// If we got here, attach a new div
			var toinsert = this.create_output_area();
			var append_text = OutputArea.append_map['text/plain'];
			if (append_text) {
					append_text.apply(this, [text, {}, toinsert]).addClass("output_stream " + subclass);
			}
			this._safe_append(toinsert);
			return true;
	};


	OutputArea.prototype.append_unrecognized = function (json) {
			var that = this;
			var toinsert = this.create_output_area();
			var subarea = $('<div/>').addClass('output_subarea output_unrecognized');
			toinsert.append(subarea);
			subarea.append(
					$("<a>")
							.attr("href", "#")
							.text("Unrecognized output: " + json.output_type)
							.click(function () {
									that.events.trigger('unrecognized_output.OutputArea', {output: json});
							})
			);
			this._safe_append(toinsert);
	};


	OutputArea.prototype.append_display_data = function (json, handle_inserted) {
			var toinsert = this.create_output_area();
			if (this.append_mime_type(json, toinsert, handle_inserted)) {
					this._safe_append(toinsert);
					// If we just output latex, typeset it.
					if ((json.data['text/latex'] !== undefined) ||
							(json.data['text/html'] !== undefined) ||
							(json.data['text/markdown'] !== undefined)) {
							this.typeset();
					}
			}
	};


	OutputArea.safe_outputs = {
			'text/plain' : true,
			'text/latex' : true,
			'image/png' : true,
			'image/jpeg' : true
	};

	OutputArea.prototype.append_mime_type = function (json, element, handle_inserted) {
			for (var i=0; i < OutputArea.display_order.length; i++) {
					var type = OutputArea.display_order[i];
					var append = OutputArea.append_map[type];
					if ((json.data[type] !== undefined) && append) {
							var value = json.data[type];
							if (!this.trusted && !OutputArea.safe_outputs[type]) {
									// not trusted, sanitize HTML
									if (type==='text/html' || type==='text/svg') {
											value = security.sanitize_html(value);
									} else {
											// don't display if we don't know how to sanitize it
											console.log("Ignoring untrusted " + type + " output.");
											continue;
									}
							}
							var md = json.metadata || {};
							var toinsert = append.apply(this, [value, md, element, handle_inserted]);
							// Since only the png and jpeg mime types call the inserted
							// callback, if the mime type is something other we must call the
							// inserted callback only when the element is actually inserted
							// into the DOM.  Use a timeout of 0 to do this.
							if (['image/png', 'image/jpeg'].indexOf(type) < 0 && handle_inserted !== undefined) {
									setTimeout(handle_inserted, 0);
							}
							this.events.trigger('output_appended.OutputArea', [type, value, md, toinsert]);
							return toinsert;
					}
			}
			return null;
	};


	var append_html = function (html, md, element) {
			var type = 'text/html';
			var toinsert = this.create_output_subarea(md, "output_html rendered_html", type);
			this.keyboard_manager.register_events(toinsert);
			toinsert.append(html);
			dblclick_to_reset_size(toinsert.find('img'));
			element.append(toinsert);
			return toinsert;
	};


	var append_markdown = function(markdown, md, element) {
			var type = 'text/markdown';
			var toinsert = this.create_output_subarea(md, "output_markdown rendered_html", type);
			var text_and_math = mathjaxutils.remove_math(markdown);
			var text = text_and_math[0];
			var math = text_and_math[1];
			marked(text, function (err, html) {
					html = mathjaxutils.replace_math(html, math);
					toinsert.append(html);
			});
			dblclick_to_reset_size(toinsert.find('img'));
			element.append(toinsert);
			return toinsert;
	};


	var append_javascript = function (js, md, element) {
			/**
			 * We just eval the JS code, element appears in the local scope.
			 */
			var type = 'application/javascript';
			var toinsert = this.create_output_subarea(md, "output_javascript rendered_html", type);
			this.keyboard_manager.register_events(toinsert);
			element.append(toinsert);

			// Fix for ipython/issues/5293, make sure `element` is the area which
			// output can be inserted into at the time of JS execution.
			element = toinsert;
			try {
					eval(js);
			} catch(err) {
					console.log(err);
					this._append_javascript_error(err, toinsert);
			}
			return toinsert;
	};


	var append_text = function (data, md, element) {
			var type = 'text/plain';
			var toinsert = this.create_output_subarea(md, "output_text", type);
			// escape ANSI & HTML specials in plaintext:
			data = utils.fixConsole(data);
			data = utils.fixCarriageReturn(data);
			data = utils.autoLinkUrls(data);
			// The only user content injected with this HTML call is
			// escaped by the fixConsole() method.
			toinsert.append($("<pre/>").html(data));
			element.append(toinsert);
			return toinsert;
	};


	var append_svg = function (svg_html, md, element) {
			var type = 'image/svg+xml';
			var toinsert = this.create_output_subarea(md, "output_svg", type);

			// Get the svg element from within the HTML.
			var svg = $('<div />').html(svg_html).find('svg');
			var svg_area = $('<div />');
			var width = svg.attr('width');
			var height = svg.attr('height');
			svg
					.width('100%')
					.height('100%');
			svg_area
					.width(width)
					.height(height);

			svg_area.append(svg);
			toinsert.append(svg_area);
			element.append(toinsert);

			return toinsert;
	};

	function dblclick_to_reset_size (img) {
			/**
			 * Double-click on an image toggles confinement to notebook width
			 *
			 * img: jQuery element
			 */

			img.dblclick(function () {
					// dblclick toggles *raw* size, disabling max-width confinement.
					if (img.hasClass('unconfined')) {
							img.removeClass('unconfined');
					} else {
							img.addClass('unconfined');
					}
			});
	};

	var set_width_height = function (img, md, mime) {
			/**
			 * set width and height of an img element from metadata
			 */
			var height = _get_metadata_key(md, 'height', mime);
			if (height !== undefined) img.attr('height', height);
			var width = _get_metadata_key(md, 'width', mime);
			if (width !== undefined) img.attr('width', width);
			if (_get_metadata_key(md, 'unconfined', mime)) {
					img.addClass('unconfined');
			}
	};

	var append_png = function (png, md, element, handle_inserted) {
			var type = 'image/png';
			var toinsert = this.create_output_subarea(md, "output_png", type);
			var img = $("<img/>");
			if (handle_inserted !== undefined) {
					img.on('load', function(){
							handle_inserted(img);
					});
			}
			img[0].src = 'data:image/png;base64,'+ png;
			set_width_height(img, md, 'image/png');
			dblclick_to_reset_size(img);
			toinsert.append(img);
			element.append(toinsert);
			return toinsert;
	};


	var append_jpeg = function (jpeg, md, element, handle_inserted) {
			var type = 'image/jpeg';
			var toinsert = this.create_output_subarea(md, "output_jpeg", type);
			var img = $("<img/>");
			if (handle_inserted !== undefined) {
					img.on('load', function(){
							handle_inserted(img);
					});
			}
			img[0].src = 'data:image/jpeg;base64,'+ jpeg;
			set_width_height(img, md, 'image/jpeg');
			dblclick_to_reset_size(img);
			toinsert.append(img);
			element.append(toinsert);
			return toinsert;
	};


	var append_pdf = function (pdf, md, element) {
			var type = 'application/pdf';
			var toinsert = this.create_output_subarea(md, "output_pdf", type);
			var a = $('<a/>').attr('href', 'data:application/pdf;base64,'+pdf);
			a.attr('target', '_blank');
			a.text('View PDF');
			toinsert.append(a);
			element.append(toinsert);
			return toinsert;
	 };

	var append_latex = function (latex, md, element) {
			/**
			 * This method cannot do the typesetting because the latex first has to
			 * be on the page.
			 */
			var type = 'text/latex';
			var toinsert = this.create_output_subarea(md, "output_latex", type);
			toinsert.append(latex);
			element.append(toinsert);
			return toinsert;
	};


	OutputArea.prototype.append_raw_input = function (msg) {
			var that = this;
			this.expand();
			var content = msg.content;
			var area = this.create_output_area();

			// disable any other raw_inputs, if they are left around
			$("div.output_subarea.raw_input_container").remove();

			var input_type = content.password ? 'password' : 'text';

			area.append(
					$("<div/>")
					.addClass("box-flex1 output_subarea raw_input_container")
					.append(
							$("<pre/>")
							.addClass("raw_input_prompt")
							.text(content.prompt)
							.append(
									$("<input/>")
									.addClass("raw_input")
									.attr('type', input_type)
									.attr("size", 47)
									.keydown(function (event, ui) {
											// make sure we submit on enter,
											// and don't re-execute the *cell* on shift-enter
											if (event.which === keyboard.keycodes.enter) {
													that._submit_raw_input();
													return false;
											}
									})
							)
					)
			);

			this.element.append(area);
			var raw_input = area.find('input.raw_input');
			// Register events that enable/disable the keyboard manager while raw
			// input is focused.
			this.keyboard_manager.register_events(raw_input);
			// Note, the following line used to read raw_input.focus().focus().
			// This seemed to be needed otherwise only the cell would be focused.
			// But with the modal UI, this seems to work fine with one call to focus().
			raw_input.focus();
	};

	OutputArea.prototype._submit_raw_input = function (evt) {
			var container = this.element.find("div.raw_input_container");
			var theprompt = container.find("pre.raw_input_prompt");
			var theinput = container.find("input.raw_input");
			var value = theinput.val();
			var echo  = value;
			// don't echo if it's a password
			if (theinput.attr('type') == 'password') {
					echo = '········';
			}
			var content = {
					output_type : 'stream',
					name : 'stdout',
					text : theprompt.text() + echo + '\n'
			};
			// remove form container
			container.parent().remove();
			// replace with plaintext version in stdout
			this.append_output(content, false);
			this.events.trigger('send_input_reply.Kernel', value);
	};


	OutputArea.prototype.handle_clear_output = function (msg) {
			/**
			 * msg spec v4 had stdout, stderr, display keys
			 * v4.1 replaced these with just wait
			 * The default behavior is the same (stdout=stderr=display=True, wait=False),
			 * so v4 messages will still be properly handled,
			 * except for the rarely used clearing less than all output.
			 */
			this.clear_output(msg.content.wait || false);
	};


	OutputArea.prototype.clear_output = function(wait, ignore_que) {
			if (wait) {

					// If a clear is queued, clear before adding another to the queue.
					if (this.clear_queued) {
							this.clear_output(false);
					}

					this.clear_queued = true;
			} else {

					// Fix the output div's height if the clear_output is waiting for
					// new output (it is being used in an animation).
					if (!ignore_que && this.clear_queued) {
							var height = this.element.height();
							this.element.height(height);
							this.clear_queued = false;
					}

					// Clear all
					// Remove load event handlers from img tags because we don't want
					// them to fire if the image is never added to the page.
					this.element.find('img').off('load');
					this.element.html("");

					// Notify others of changes.
					this.element.trigger('changed');

					this.outputs = [];
					this.trusted = true;
					this.unscroll_area();
					return;
			}
	};


	// JSON serialization

	OutputArea.prototype.fromJSON = function (outputs, metadata) {
			var len = outputs.length;
			metadata = metadata || {};

			for (var i=0; i<len; i++) {
					this.append_output(outputs[i]);
			}
			if (metadata.collapsed !== undefined) {
					if (metadata.collapsed) {
							this.collapse();
					} else {
							this.expand();
					}
			}
			if (metadata.scrolled !== undefined) {
					this.scroll_state = metadata.scrolled;
					if (metadata.scrolled) {
							this.scroll_if_long();
					} else {
							this.unscroll_area();
					}
			}
	};


	OutputArea.prototype.toJSON = function () {
			return this.outputs;
	};

	/**
	 * Class properties
	 **/

	/**
	 * Threshold to trigger autoscroll when the OutputArea is resized,
	 * typically when new outputs are added.
	 *
	 * Behavior is undefined if autoscroll is lower than minimum_scroll_threshold,
	 * unless it is < 0, in which case autoscroll will never be triggered
	 *
	 * @property auto_scroll_threshold
	 * @type Number
	 * @default 100
	 *
	 **/
	OutputArea.auto_scroll_threshold = 100;

	/**
	 * Lower limit (in lines) for OutputArea to be made scrollable. OutputAreas
	 * shorter than this are never scrolled.
	 *
	 * @property minimum_scroll_threshold
	 * @type Number
	 * @default 20
	 *
	 **/
	OutputArea.minimum_scroll_threshold = 20;


	OutputArea.display_order = [
			'application/javascript',
			'text/html',
			'text/markdown',
			'text/latex',
			'image/svg+xml',
			'image/png',
			'image/jpeg',
			'application/pdf',
			'text/plain'
	];

	OutputArea.append_map = {
			"text/plain" : append_text,
			"text/html" : append_html,
			"text/markdown": append_markdown,
			"image/svg+xml" : append_svg,
			"image/png" : append_png,
			"image/jpeg" : append_jpeg,
			"text/latex" : append_latex,
			"application/javascript" : append_javascript,
			"application/pdf" : append_pdf
	};

	return {'OutputArea': OutputArea};
})();

// notebook/js/contexthint
var notebookJsContextHint = (function notebookJsContextHint() {
	"use strict";

	var forEach = function(arr, f) {
			for (var i = 0, e = arr.length; i < e; ++i) f(arr[i]);
	};

	var arrayContains = function(arr, item) {
			if (!Array.prototype.indexOf) {
					var i = arr.length;
					while (i--) {
							if (arr[i] === item) {
									return true;
							}
					}
					return false;
			}
			return arr.indexOf(item) != -1;
	};

	CodeMirror.contextHint = function (editor) {
			// Find the token at the cursor
			var cur = editor.getCursor(),
					token = editor.getTokenAt(cur),
					tprop = token;
			// If it's not a 'word-style' token, ignore the token.
			// If it is a property, find out what it is a property of.
			var list = [];
			var clist = getCompletions(token, editor);
			for (var i = 0; i < clist.length; i++) {
					list.push({
							str: clist[i],
							type: "context",
							from: {
									line: cur.line,
									ch: token.start
							},
							to: {
									line: cur.line,
									ch: token.end
							}
					});
			}
			return list;
	};

	// find all 'words' of current cell
	var getAllTokens = function (editor) {
			var found = [];

			// add to found if not already in it


			function maybeAdd(str) {
					if (!arrayContains(found, str)) found.push(str);
			}

			// loop through all token on all lines
			var lineCount = editor.lineCount();
			// loop on line
			for (var l = 0; l < lineCount; l++) {
					var line = editor.getLine(l);
					//loop on char
					for (var c = 1; c < line.length; c++) {
							var tk = editor.getTokenAt({
									line: l,
									ch: c
							});
							// if token has a class, it has geat chances of beeing
							// of interest. Add it to the list of possible completions.
							// we could skip token of ClassName 'comment'
							// or 'number' and 'operator'
							if (tk.className !== null) {
									maybeAdd(tk.string);
							}
							// jump to char after end of current token
							c = tk.end;
					}
			}
			return found;
	};

	var getCompletions = function(token, editor) {
			var candidates = getAllTokens(editor);
			// filter all token that have a common start (but nox exactly) the lenght of the current token
			var lambda = function (x) {
							return (x.indexOf(token.string) === 0 && x != token.string);
					};
			var filterd = candidates.filter(lambda);
			return filterd;
	};

	return {'contextHint': CodeMirror.contextHint};
})();

// notebook/js/completer
var notebookJsCompleter = (function notebookJsCompleter() {
	"use strict";

	var util = baseJsUtils;
    var keyboard = baseJsKeyboard;
    // notebookJsContextHint

	// easier key mapping
	var keycodes = keyboard.keycodes;

	var prepend_n_prc = function(str, n) {
			for( var i =0 ; i< n ; i++){
					str = '%'+str ;
			}
			return str;
	};

	var _existing_completion = function(item, completion_array){
			for( var i=0; i < completion_array.length; i++) {
					if (completion_array[i].trim().substr(-item.length) == item) {
							return true;
					}
			}
			return false;
	};

	// what is the common start of all completions
	function shared_start(B, drop_prct) {
			if (B.length == 1) {
					return B[0];
			}
			var A = [];
			var common;
			var min_lead_prct = 10;
			for (var i = 0; i < B.length; i++) {
					var str = B[i].str;
					var localmin = 0;
					if(drop_prct === true){
							while ( str.substr(0, 1) == '%') {
									localmin = localmin+1;
									str = str.substring(1);
							}
					}
					min_lead_prct = Math.min(min_lead_prct, localmin);
					A.push(str);
			}

			if (A.length > 1) {
					var tem1, tem2, s;
					A = A.slice(0).sort();
					tem1 = A[0];
					s = tem1.length;
					tem2 = A.pop();
					while (s && tem2.indexOf(tem1) == -1) {
							tem1 = tem1.substring(0, --s);
					}
					if (tem1 === "" || tem2.indexOf(tem1) !== 0) {
							return {
									str:prepend_n_prc('', min_lead_prct),
									type: "computed",
									from: B[0].from,
									to: B[0].to
									};
					}
					return {
							str: prepend_n_prc(tem1, min_lead_prct),
							type: "computed",
							from: B[0].from,
							to: B[0].to
					};
			}
			return null;
	}


	var Completer = function (cell, events) {
			this.cell = cell;
			this.editor = cell.code_mirror;
			var that = this;
			events.on('kernel_busy.Kernel', function () {
					that.skip_kernel_completion = true;
			});
			events.on('kernel_idle.Kernel', function () {
					that.skip_kernel_completion = false;
			});
	};

	Completer.prototype.startCompletion = function () {
			/**
			 * call for a 'first' completion, that will set the editor and do some
			 * special behavior like autopicking if only one completion available.
			 */
			if (this.editor.somethingSelected()|| this.editor.getSelections().length > 1) return;
			this.done = false;
			// use to get focus back on opera
			this.carry_on_completion(true);
	};


	// easy access for julia to monkeypatch
	//
	Completer.reinvoke_re = /[%0-9a-z._/\\:~-]/i;

	Completer.prototype.reinvoke= function(pre_cursor, block, cursor){
			return Completer.reinvoke_re.test(pre_cursor);
	};

	/**
	 *
	 * pass true as parameter if this is the first invocation of the completer
	 * this will prevent the completer to dissmiss itself if it is not on a
	 * word boundary like pressing tab after a space, and make it autopick the
	 * only choice if there is only one which prevent from popping the UI.  as
	 * well as fast-forwarding the typing if all completion have a common
	 * shared start
	 **/
	Completer.prototype.carry_on_completion = function (first_invocation) {
			/**
			 * Pass true as parameter if you want the completer to autopick when
			 * only one completion. This function is automatically reinvoked at
			 * each keystroke with first_invocation = false
			 */
			var cur = this.editor.getCursor();
			var line = this.editor.getLine(cur.line);
			var pre_cursor = this.editor.getRange({
					line: cur.line,
					ch: cur.ch - 1
			}, cur);

			// we need to check that we are still on a word boundary
			// because while typing the completer is still reinvoking itself
			// so dismiss if we are on a "bad" caracter
			if (!this.reinvoke(pre_cursor) && !first_invocation) {
					this.close();
					return;
			}

			this.autopick = false;
			if (first_invocation) {
					this.autopick = true;
			}

			// We want a single cursor position.
			if (this.editor.somethingSelected()|| this.editor.getSelections().length > 1) {
					return;
			}

			// one kernel completion came back, finish_completing will be called with the results
			// we fork here and directly call finish completing if kernel is busy
			var cursor_pos = utils.to_absolute_cursor_pos(this.editor, cur);
			if (this.skip_kernel_completion) {
					this.finish_completing({ content: {
							matches: [],
							cursor_start: cursor_pos,
							cursor_end: cursor_pos,
					}});
			} else {
					this.cell.kernel.complete(this.editor.getValue(), cursor_pos,
							$.proxy(this.finish_completing, this)
					);
			}
	};

	Completer.prototype.finish_completing = function (msg) {
			/**
			 * let's build a function that wrap all that stuff into what is needed
			 * for the new completer:
			 */
			var content = msg.content;
			var start = content.cursor_start;
			var end = content.cursor_end;
			var matches = content.matches;

			var cur = this.editor.getCursor();
			if (end === null) {
					// adapted message spec replies don't have cursor position info,
					// interpret end=null as current position,
					// and negative start relative to that
					end = utils.to_absolute_cursor_pos(this.editor, cur);
					if (start === null) {
							start = end;
					} else if (start < 0) {
							start = end + start;
					}
			}
			var results = CodeMirror.contextHint(this.editor);
			var filtered_results = [];
			//remove results from context completion
			//that are already in kernel completion
			var i;
			for (i=0; i < results.length; i++) {
					if (!_existing_completion(results[i].str, matches)) {
							filtered_results.push(results[i]);
					}
			}

			// append the introspection result, in order, at at the beginning of
			// the table and compute the replacement range from current cursor
			// positon and matched_text length.
			var from = utils.from_absolute_cursor_pos(this.editor, start);
			var to = utils.from_absolute_cursor_pos(this.editor, end);
			for (i = matches.length - 1; i >= 0; --i) {
					filtered_results.unshift({
							str: matches[i],
							type: "introspection",
							from: from,
							to: to
					});
			}

			// one the 2 sources results have been merge, deal with it
			this.raw_result = filtered_results;

			// if empty result return
			if (!this.raw_result || !this.raw_result.length) return;

			// When there is only one completion, use it directly.
			if (this.autopick && this.raw_result.length == 1) {
					this.insert(this.raw_result[0]);
					return;
			}

			if (this.raw_result.length == 1) {
					// test if first and only completion totally matches
					// what is typed, in this case dismiss
					var str = this.raw_result[0].str;
					var pre_cursor = this.editor.getRange({
							line: cur.line,
							ch: cur.ch - str.length
					}, cur);
					if (pre_cursor == str) {
							this.close();
							return;
					}
			}

			if (!this.visible) {
					this.complete = $('<div/>').addClass('completions');
					this.complete.attr('id', 'complete');

					// Currently webkit doesn't use the size attr correctly. See:
					// https://code.google.com/p/chromium/issues/detail?id=4579
					this.sel = $('<select/>')
							.attr('tabindex', -1)
							.attr('multiple', 'true');
					this.complete.append(this.sel);
					this.visible = true;
					$('body').append(this.complete);

					//build the container
					var that = this;
					this.sel.dblclick(function () {
							that.pick();
					});
					this.sel.focus(function () {
							that.editor.focus();
					});
					this._handle_keydown = function (cm, event) {
							that.keydown(event);
					};
					this.editor.on('keydown', this._handle_keydown);
					this._handle_keypress = function (cm, event) {
							that.keypress(event);
					};
					this.editor.on('keypress', this._handle_keypress);
			}
			this.sel.attr('size', Math.min(10, this.raw_result.length));

			// After everything is on the page, compute the postion.
			// We put it above the code if it is too close to the bottom of the page.
			var pos = this.editor.cursorCoords(
					utils.from_absolute_cursor_pos(this.editor, start)
			);
			var left = pos.left-3;
			var top;
			var cheight = this.complete.height();
			var wheight = $(window).height();
			if (pos.bottom+cheight+5 > wheight) {
					top = pos.top-cheight-4;
			} else {
					top = pos.bottom+1;
			}
			this.complete.css('left', left + 'px');
			this.complete.css('top', top + 'px');

			// Clear and fill the list.
			this.sel.text('');
			this.build_gui_list(this.raw_result);
			return true;
	};

	Completer.prototype.insert = function (completion) {
			this.editor.replaceRange(completion.str, completion.from, completion.to);
	};

	Completer.prototype.build_gui_list = function (completions) {
			for (var i = 0; i < completions.length; ++i) {
					var opt = $('<option/>').text(completions[i].str).addClass(completions[i].type);
					this.sel.append(opt);
			}
			this.sel.children().first().attr('selected', 'true');
			this.sel.scrollTop(0);
	};

	Completer.prototype.close = function () {
			this.done = true;
			$('#complete').remove();
			this.editor.off('keydown', this._handle_keydown);
			this.editor.off('keypress', this._handle_keypress);
			this.visible = false;
	};

	Completer.prototype.pick = function () {
			this.insert(this.raw_result[this.sel[0].selectedIndex]);
			this.close();
	};

	Completer.prototype.keydown = function (event) {
			var code = event.keyCode;

			// Enter
			var options;
			var index;
			if (code == keycodes.enter) {
					event.codemirrorIgnore = true;
					event._ipkmIgnore = true;
					event.preventDefault();
					this.pick();
			// Escape or backspace
			} else if (code == keycodes.esc || code == keycodes.backspace) {
					event.codemirrorIgnore = true;
					event._ipkmIgnore = true;
					event.preventDefault();
					this.close();
			} else if (code == keycodes.tab) {
					//all the fastforwarding operation,
					//Check that shared start is not null which can append with prefixed completion
					// like %pylab , pylab have no shred start, and ff will result in py<tab><tab>
					// to erase py
					var sh = shared_start(this.raw_result, true);
					if (sh.str !== '') {
							this.insert(sh);
					}
					this.close();
					this.carry_on_completion();
			} else if (code == keycodes.up || code == keycodes.down) {
					// need to do that to be able to move the arrow
					// when on the first or last line ofo a code cell
					event.codemirrorIgnore = true;
					event._ipkmIgnore = true;
					event.preventDefault();

					options = this.sel.find('option');
					index = this.sel[0].selectedIndex;
					if (code == keycodes.up) {
							index--;
					}
					if (code == keycodes.down) {
							index++;
					}
					index = Math.min(Math.max(index, 0), options.length-1);
					this.sel[0].selectedIndex = index;
			} else if (code == keycodes.pageup || code == keycodes.pagedown) {
					event._ipkmIgnore = true;

					options = this.sel.find('option');
					index = this.sel[0].selectedIndex;
					if (code == keycodes.pageup) {
							index -= 10; // As 10 is the hard coded size of the drop down menu
					} else {
							index += 10;
					}
					index = Math.min(Math.max(index, 0), options.length-1);
					this.sel[0].selectedIndex = index;
			} else if (code == keycodes.left || code == keycodes.right) {
					this.close();
			}
	};

	Completer.prototype.keypress = function (event) {
			/**
			 * FIXME: This is a band-aid.
			 * on keypress, trigger insertion of a single character.
			 * This simulates the old behavior of completion as you type,
			 * before events were disconnected and CodeMirror stopped
			 * receiving events while the completer is focused.
			 */

			var that = this;
			var code = event.keyCode;

			// don't handle keypress if it's not a character (arrows on FF)
			// or ENTER/TAB
			if (event.charCode === 0 ||
					code == keycodes.tab ||
					code == keycodes.enter
			) return;

			this.close();
			this.editor.focus();
			setTimeout(function () {
					that.carry_on_completion();
			}, 50);
	};

	return {'Completer': Completer};
})();

// notebook/js/codecell
var notebookJsCodecell = (function notebookJsCodecell() {
	"use strict";

	var utils = baseJsUtils;
	var keyboard = baseJsKeyboard;
	var configmod = serviceConfig;
	var cell = notebookJsCell;
	var outputarea = notebookJsOutputarea;
  var completer = notebookJsCompleter;
  var celltoolbar = notebookJsCelltoolbar;

	var Cell = cell.Cell;

	/* local util for codemirror */
	var posEq = function(a, b) {return a.line === b.line && a.ch === b.ch;};

	/**
	 *
	 * function to delete until previous non blanking space character
	 * or first multiple of 4 tabstop.
	 * @private
	 */
	CodeMirror.commands.delSpaceToPrevTabStop = function(cm){
			var from = cm.getCursor(true), to = cm.getCursor(false), sel = !posEq(from, to);
			if (!posEq(from, to)) { cm.replaceRange("", from, to); return; }
			var cur = cm.getCursor(), line = cm.getLine(cur.line);
			var tabsize = cm.getOption('tabSize');
			var chToPrevTabStop = cur.ch-(Math.ceil(cur.ch/tabsize)-1)*tabsize;
			from = {ch:cur.ch-chToPrevTabStop,line:cur.line};
			var select = cm.getRange(from,cur);
			if( select.match(/^\ +$/) !== null){
					cm.replaceRange("",from,cur);
			} else {
					cm.deleteH(-1,"char");
			}
	};

	var keycodes = keyboard.keycodes;

	var CodeCell = function (kernel, options) {
			/**
			 * Constructor
			 *
			 * A Cell conceived to write code.
			 *
			 * Parameters:
			 *  kernel: Kernel instance
			 *      The kernel doesn't have to be set at creation time, in that case
			 *      it will be null and set_kernel has to be called later.
			 *  options: dictionary
			 *      Dictionary of keyword arguments.
			 *          events: $(Events) instance
			 *          config: dictionary
			 *          keyboard_manager: KeyboardManager instance
			 *          notebook: Notebook instance
			 *          tooltip: Tooltip instance
			 */
			this.kernel = kernel || null;
			this.notebook = options.notebook;
			this.collapsed = false;
			this.events = options.events;
			this.tooltip = options.tooltip;
			this.config = options.config;
			this.class_config = new configmod.ConfigWithDefaults(this.config,
																			CodeCell.config_defaults, 'CodeCell');

			// create all attributed in constructor function
			// even if null for V8 VM optimisation
			this.input_prompt_number = null;
			this.celltoolbar = null;
			this.output_area = null;

			this.last_msg_id = null;
			this.completer = null;

			Cell.apply(this,[{
					config: $.extend({}, CodeCell.options_default),
					keyboard_manager: options.keyboard_manager,
					events: this.events}]);

			// Attributes we want to override in this subclass.
			this.cell_type = "code";
			var that  = this;
			this.element.focusout(
					function() { that.auto_highlight(); }
			);
	};

	CodeCell.options_default = {
			cm_config : {
					extraKeys: {
							"Tab" :  "indentMore",
							"Shift-Tab" : "indentLess",
							"Backspace" : "delSpaceToPrevTabStop",
							"Cmd-/" : "toggleComment",
							"Ctrl-/" : "toggleComment"
					},
					mode: 'text',
					theme: 'ipython',
					matchBrackets: true,
					autoCloseBrackets: true,
					readOnly: 'nocursor'
			},
			highlight_modes : {
					'magic_javascript'    :{'reg':['^%%javascript']},
					'magic_perl'          :{'reg':['^%%perl']},
					'magic_ruby'          :{'reg':['^%%ruby']},
					'magic_python'        :{'reg':['^%%python3?']},
					'magic_shell'         :{'reg':['^%%bash']},
					'magic_r'             :{'reg':['^%%R']},
					'magic_text/x-cython' :{'reg':['^%%cython']},
			},
	};

	CodeCell.config_defaults = CodeCell.options_default;

	CodeCell.msg_cells = {};

	CodeCell.prototype = Object.create(Cell.prototype);

	/** @method create_element */
	CodeCell.prototype.create_element = function () {
			Cell.prototype.create_element.apply(this, arguments);
			var that = this;

			var cell =  $('<div></div>').addClass('cell code_cell');
			cell.attr('tabindex','2');

			var input = $('<div></div>').addClass('input');
			this.input = input;
			var prompt = $('<div/>').addClass('prompt input_prompt');
			var inner_cell = $('<div/>').addClass('inner_cell');
			this.celltoolbar = new celltoolbar.CellToolbar({
					cell: this,
					notebook: this.notebook});
			inner_cell.append(this.celltoolbar.element);
			var input_area = $('<div/>').addClass('input_area');
			this.code_mirror = new CodeMirror(input_area.get(0), this._options.cm_config);
			// In case of bugs that put the keyboard manager into an inconsistent state,
			// ensure KM is enabled when CodeMirror is focused:
			this.code_mirror.on('focus', function () {
					if (that.keyboard_manager) {
							that.keyboard_manager.enable();
					}
			});
			this.code_mirror.on('keydown', $.proxy(this.handle_keyevent,this));
			$(this.code_mirror.getInputField()).attr("spellcheck", "false");
			inner_cell.append(input_area);
			input.append(prompt).append(inner_cell);

			var output = $('<div></div>');
			cell.append(input).append(output);
			this.element = cell;
			this.output_area = new outputarea.OutputArea({
					selector: output,
					prompt_area: true,
					events: this.events,
					keyboard_manager: this.keyboard_manager});
			this.completer = new completer.Completer(this, this.events);
	};

	/** @method bind_events */
	CodeCell.prototype.bind_events = function () {
			Cell.prototype.bind_events.apply(this);
			var that = this;

			this.element.focusout(
					function() { that.auto_highlight(); }
			);
	};


	/**
	 *  This method gets called in CodeMirror's onKeyDown/onKeyPress
	 *  handlers and is used to provide custom key handling. Its return
	 *  value is used to determine if CodeMirror should ignore the event:
	 *  true = ignore, false = don't ignore.
	 *  @method handle_codemirror_keyevent
	 */

	CodeCell.prototype.handle_codemirror_keyevent = function (editor, event) {

			var that = this;
			// whatever key is pressed, first, cancel the tooltip request before
			// they are sent, and remove tooltip if any, except for tab again
			var tooltip_closed = null;
			if (event.type === 'keydown' && event.which !== keycodes.tab ) {
					tooltip_closed = this.tooltip.remove_and_cancel_tooltip();
			}

			var cur = editor.getCursor();
			if (event.keyCode === keycodes.enter){
					this.auto_highlight();
			}

			if (event.which === keycodes.down && event.type === 'keypress' && this.tooltip.time_before_tooltip >= 0) {
					// triger on keypress (!) otherwise inconsistent event.which depending on plateform
					// browser and keyboard layout !
					// Pressing '(' , request tooltip, don't forget to reappend it
					// The second argument says to hide the tooltip if the docstring
					// is actually empty
					this.tooltip.pending(that, true);
			} else if ( tooltip_closed && event.which === keycodes.esc && event.type === 'keydown') {
					// If tooltip is active, cancel it.  The call to
					// remove_and_cancel_tooltip above doesn't pass, force=true.
					// Because of this it won't actually close the tooltip
					// if it is in sticky mode. Thus, we have to check again if it is open
					// and close it with force=true.
					if (!this.tooltip._hidden) {
							this.tooltip.remove_and_cancel_tooltip(true);
					}
					// If we closed the tooltip, don't let CM or the global handlers
					// handle this event.
					event.codemirrorIgnore = true;
					event._ipkmIgnore = true;
					event.preventDefault();
					return true;
			} else if (event.keyCode === keycodes.tab && event.type === 'keydown' && event.shiftKey) {
							if (editor.somethingSelected() || editor.getSelections().length !== 1){
									var anchor = editor.getCursor("anchor");
									var head = editor.getCursor("head");
									if( anchor.line !== head.line){
											return false;
									}
							}
							var pre_cursor = editor.getRange({line:cur.line,ch:0},cur);
							if (pre_cursor.trim() === "") {
									// Don't show tooltip if the part of the line before the cursor
									// is empty.  In this case, let CodeMirror handle indentation.
									return false;
							}
							this.tooltip.request(that);
							event.codemirrorIgnore = true;
							event.preventDefault();
							return true;
			} else if (event.keyCode === keycodes.tab && event.type === 'keydown') {
					// Tab completion.
					this.tooltip.remove_and_cancel_tooltip();

					// completion does not work on multicursor, it might be possible though in some cases
					if (editor.somethingSelected() || editor.getSelections().length > 1) {
							return false;
					}
					var pre_cursor = editor.getRange({line:cur.line,ch:0},cur);
					if (pre_cursor.trim() === "") {
							// Don't autocomplete if the part of the line before the cursor
							// is empty.  In this case, let CodeMirror handle indentation.
							return false;
					} else {
							event.codemirrorIgnore = true;
							event.preventDefault();
							this.completer.startCompletion();
							return true;
					}
			}

			// keyboard event wasn't one of those unique to code cells, let's see
			// if it's one of the generic ones (i.e. check edit mode shortcuts)
			return Cell.prototype.handle_codemirror_keyevent.apply(this, [editor, event]);
	};

	// Kernel related calls.

	CodeCell.prototype.set_kernel = function (kernel) {
			this.kernel = kernel;
	};

	/**
	 * Execute current code cell to the kernel
	 * @method execute
	 */
	CodeCell.prototype.execute = function (stop_on_error) {
			if (!this.kernel || !this.kernel.is_connected()) {
					console.log("Can't execute, kernel is not connected.");
					return;
			}

			this.output_area.clear_output(false, true);

			if (stop_on_error === undefined) {
					stop_on_error = true;
			}

			var old_msg_id = this.last_msg_id;

			if (old_msg_id) {
					this.kernel.clear_callbacks_for_msg(old_msg_id);
					if (old_msg_id) {
							delete CodeCell.msg_cells[old_msg_id];
					}
			}
			if (this.get_text().trim().length === 0) {
					// nothing to do
					this.set_input_prompt(null);
					return;
			}
			this.set_input_prompt('*');
			this.element.addClass("running");
			var callbacks = this.get_callbacks();

			this.last_msg_id = this.kernel.execute(this.get_text(), callbacks, {silent: false, store_history: true,
					stop_on_error : stop_on_error});
			CodeCell.msg_cells[this.last_msg_id] = this;
			this.render();
			this.events.trigger('execute.CodeCell', {cell: this});
	};

	/**
	 * Construct the default callbacks for
	 * @method get_callbacks
	 */
	CodeCell.prototype.get_callbacks = function () {
			var that = this;
			return {
					shell : {
							reply : $.proxy(this._handle_execute_reply, this),
							payload : {
									set_next_input : $.proxy(this._handle_set_next_input, this),
									page : $.proxy(this._open_with_pager, this)
							}
					},
					iopub : {
							output : function() {
									that.output_area.handle_output.apply(that.output_area, arguments);
							},
							clear_output : function() {
									that.output_area.handle_clear_output.apply(that.output_area, arguments);
							},
					},
					input : $.proxy(this._handle_input_request, this)
			};
	};

	CodeCell.prototype._open_with_pager = function (payload) {
			this.events.trigger('open_with_text.Pager', payload);
	};

	/**
	 * @method _handle_execute_reply
	 * @private
	 */
	CodeCell.prototype._handle_execute_reply = function (msg) {
			this.set_input_prompt(msg.content.execution_count);
			this.element.removeClass("running");
			this.events.trigger('set_dirty.Notebook', {value: true});
	};

	/**
	 * @method _handle_set_next_input
	 * @private
	 */
	CodeCell.prototype._handle_set_next_input = function (payload) {
			var data = {'cell': this, 'text': payload.text, replace: payload.replace};
			this.events.trigger('set_next_input.Notebook', data);
	};

	/**
	 * @method _handle_input_request
	 * @private
	 */
	CodeCell.prototype._handle_input_request = function (msg) {
			this.output_area.append_raw_input(msg);
	};


	// Basic cell manipulation.

	CodeCell.prototype.select = function () {
			var cont = Cell.prototype.select.apply(this);
			if (cont) {
					this.code_mirror.refresh();
					this.auto_highlight();
			}
			return cont;
	};

	CodeCell.prototype.render = function () {
			var cont = Cell.prototype.render.apply(this);
			// Always execute, even if we are already in the rendered state
			return cont;
	};

	CodeCell.prototype.select_all = function () {
			var start = {line: 0, ch: 0};
			var nlines = this.code_mirror.lineCount();
			var last_line = this.code_mirror.getLine(nlines-1);
			var end = {line: nlines-1, ch: last_line.length};
			this.code_mirror.setSelection(start, end);
	};


	CodeCell.prototype.collapse_output = function () {
			this.output_area.collapse();
	};


	CodeCell.prototype.expand_output = function () {
			this.output_area.expand();
			this.output_area.unscroll_area();
	};

	CodeCell.prototype.scroll_output = function () {
			this.output_area.expand();
			this.output_area.scroll_if_long();
	};

	CodeCell.prototype.toggle_output = function () {
			this.output_area.toggle_output();
	};

	CodeCell.prototype.toggle_output_scroll = function () {
			this.output_area.toggle_scroll();
	};


	CodeCell.input_prompt_classical = function (prompt_value, lines_number) {
			var ns;
			if (prompt_value === undefined || prompt_value === null) {
					ns = "&nbsp;";
			} else {
					ns = encodeURIComponent(prompt_value);
			}
			return 'In&nbsp;[' + ns + ']:';
	};

	CodeCell.input_prompt_continuation = function (prompt_value, lines_number) {
			var html = [CodeCell.input_prompt_classical(prompt_value, lines_number)];
			for(var i=1; i < lines_number; i++) {
					html.push(['...:']);
			}
			return html.join('<br/>');
	};

	CodeCell.input_prompt_function = CodeCell.input_prompt_classical;


	CodeCell.prototype.set_input_prompt = function (number) {
			var nline = 1;
			if (this.code_mirror !== undefined) {
				 nline = this.code_mirror.lineCount();
			}
			this.input_prompt_number = number;
			var prompt_html = CodeCell.input_prompt_function(this.input_prompt_number, nline);
			// This HTML call is okay because the user contents are escaped.
			this.element.find('div.input_prompt').html(prompt_html);
	};


	CodeCell.prototype.clear_input = function () {
			this.code_mirror.setValue('');
	};


	CodeCell.prototype.get_text = function () {
			return this.code_mirror.getValue();
	};


	CodeCell.prototype.set_text = function (code) {
			code = $.isArray(code) ? code.join('') : code;
			return this.code_mirror.setValue(code);
	};


	CodeCell.prototype.clear_output = function (wait) {
			this.output_area.clear_output(wait);
			this.set_input_prompt();
	};


	// JSON serialization

	CodeCell.prototype.fromJSON = function (data) {
			Cell.prototype.fromJSON.apply(this, arguments);
			if (data.cell_type === 'code') {
					if (data.source !== undefined) {
							this.set_text(data.source);
							// make this value the starting point, so that we can only undo
							// to this state, instead of a blank cell
							this.code_mirror.clearHistory();
							this.auto_highlight();
					}
					this.set_input_prompt(data.execution_count);
					this.output_area.trusted = data.metadata.trusted || false;
					this.output_area.fromJSON(data.outputs, data.metadata);
			}
	};


	CodeCell.prototype.toJSON = function () {
			var data = Cell.prototype.toJSON.apply(this);
			data.source = this.get_text();
			// is finite protect against undefined and '*' value
			if (isFinite(this.input_prompt_number)) {
					data.execution_count = this.input_prompt_number;
			} else {
					data.execution_count = null;
			}
			var outputs = this.output_area.toJSON();
			data.outputs = outputs;
			data.metadata.trusted = this.output_area.trusted;
			data.metadata.collapsed = this.output_area.collapsed;
			if (this.output_area.scroll_state === 'auto') {
					delete data.metadata.scrolled;
			} else {
					data.metadata.scrolled = this.output_area.scroll_state;
			}
			return data;
	};

	/**
	 * handle cell level logic when a cell is unselected
	 * @method unselect
	 * @return is the action being taken
	 */
	CodeCell.prototype.unselect = function () {
			var cont = Cell.prototype.unselect.apply(this);
			if (cont) {
					// When a code cell is usnelected, make sure that the corresponding
					// tooltip and completer to that cell is closed.
					this.tooltip.remove_and_cancel_tooltip(true);
					if (this.completer !== null) {
							this.completer.close();
					}
			}
			return cont;
	};

	// Backwards compatability.
	IPython.CodeCell = CodeCell;

	return {'CodeCell': CodeCell};
})();

var notebookJsNotebook = (function notebookJsNotebook() {
	"use strict";
	// var IPython = require('base/js/namespace');
	var utils = baseJsUtils;
	var dialog = baseJsDialog;
	var cellmod = notebookJsCell;
	var textcell = notebookJsTextCell;
	var codecell = notebookJsCodecell;
	// var moment = require('moment');
	var configmod = serviceConfig;
	var session = servicesSessionsSession;
	var celltoolbar = notebookJsCelltoolbar;
	// var marked = require('components/marked/lib/marked');
	// var CodeMirror = require('codemirror/lib/codemirror');
	// var runMode = require('codemirror/addon/runmode/runmode');
	var mathjaxutils = notebookJsMathjaxutils;
	var keyboard = baseJsKeyboard;
	var tooltip = notebookJsTooltip
	var default_celltoolbar = notebookJsCellToolbarPresetsDefault
	var rawcell_celltoolbar = notebookJsCellToolbarPresetsRawcell;
	var slideshow_celltoolbar = notebookJsCellToolbarPresetsSlideshow;
	var scrollmanager = notebookJsScrollmanager;

	/**
	 * Contains and manages cells.
	 *
	 * @class Notebook
	 * @param {string}          selector
	 * @param {object}          options - Dictionary of keyword arguments.
	 * @param {jQuery}          options.events - selector of Events
	 * @param {KeyboardManager} options.keyboard_manager
	 * @param {Contents}        options.contents
	 * @param {object}          options.config
	 * @param {string}          options.base_url
	 * @param {string}          options.notebook_path
	 * @param {string}          options.notebook_name
	 */
	var Notebook = function (selector, options) {
			this.config = options.config;
			this.class_config = new configmod.ConfigWithDefaults(this.config,
																			Notebook.options_default, 'Notebook');
			this.base_url = options.base_url;
			this.notebook_path = options.notebook_path;
			this.notebook_name = options.notebook_name;
			this.events = options.events;
			this.keyboard_manager = options.keyboard_manager;
			this.contents = options.contents;
			this.tooltip = new tooltip.Tooltip(this.events);
			this.ws_url = options.ws_url;
			this._session_starting = false;
			this.last_modified = null;

			//  Create default scroll manager.
			this.scroll_manager = new scrollmanager.ScrollManager(this);

			// TODO: This code smells (and the other `= this` line a couple lines down)
			// We need a better way to deal with circular instance references.
			this.keyboard_manager.notebook = this;

			if (marked) {
					marked.setOptions({
							gfm : true,
							tables: true,
							// FIXME: probably want central config for CodeMirror theme when we have js config
							langPrefix: "cm-s-ipython language-",
							highlight: function(code, lang, callback) {
									if (!lang) {
											// no language, no highlight
											if (callback) {
													callback(null, code);
													return;
											} else {
													return code;
											}
									}
									utils.requireCodeMirrorMode(lang, function (spec) {
											var el = document.createElement("div");
											var mode = CodeMirror.getMode({}, spec);
											if (!mode) {
													console.log("No CodeMirror mode: " + lang);
													callback(null, code);
													return;
											}
											try {
													CodeMirror.runMode(code, spec, el);
													callback(null, el.innerHTML);
											} catch (err) {
													console.log("Failed to highlight " + lang + " code", err);
													callback(err, code);
											}
									}, function (err) {
											console.log("No CodeMirror mode: " + lang);
											callback(err, code);
									});
							}
					});
			}

			this.element = $(selector);
			this.element.scroll();
			this.element.data("notebook", this);
			this.next_prompt_number = 1;
			this.session = null;
			this.kernel = null;
			this.kernel_busy = false;
			this.clipboard = null;
			this.undelete_backup = null;
			this.undelete_index = null;
			this.undelete_below = false;
			this.paste_enabled = false;
			this.writable = false;
			// It is important to start out in command mode to match the intial mode
			// of the KeyboardManager.
			this.mode = 'command';
			this.set_dirty(false);
			this.metadata = {};
			this._checkpoint_after_save = false;
			this.last_checkpoint = null;
			this.checkpoints = [];
			this.autosave_interval = 0;
			this.autosave_timer = null;
			// autosave *at most* every two minutes
			this.minimum_autosave_interval = 120000;
			this.notebook_name_blacklist_re = /[\/\\:]/;
			this.nbformat = 4; // Increment this when changing the nbformat
			this.nbformat_minor = this.current_nbformat_minor = 0; // Increment this when changing the nbformat
			this.codemirror_mode = 'text';
			this.create_elements();
			this.bind_events();
			this.kernel_selector = null;
			this.dirty = null;
			this.trusted = null;
			this._fully_loaded = false;

			// Trigger cell toolbar registration.
			default_celltoolbar.register(this);
			rawcell_celltoolbar.register(this);
			slideshow_celltoolbar.register(this);

			// prevent assign to miss-typed properties.
			Object.seal(this);
	};

	Notebook.options_default = {
			// can be any cell type, or the special values of
			// 'above', 'below', or 'selected' to get the value from another cell.
			default_cell_type: 'code'
	};

	/**
	 * Create an HTML and CSS representation of the notebook.
	 */
	Notebook.prototype.create_elements = function () {
			var that = this;
			this.element.attr('tabindex','-1');
			this.container = $("<div/>").addClass("container").attr("id", "notebook-container");
			// We add this end_space div to the end of the notebook div to:
			// i) provide a margin between the last cell and the end of the notebook
			// ii) to prevent the div from scrolling up when the last cell is being
			// edited, but is too low on the page, which browsers will do automatically.
			var end_space = $('<div/>').addClass('end_space');
			end_space.dblclick(function (e) {
					var ncells = that.ncells();
					that.insert_cell_below('code',ncells-1);
			});
			this.element.append(this.container);
			this.container.after(end_space);
	};

	/**
	 * Bind JavaScript events: key presses and custom Jupyter events.
	 */
	Notebook.prototype.bind_events = function () {
			var that = this;

			this.events.on('set_next_input.Notebook', function (event, data) {
					if (data.replace) {
							data.cell.set_text(data.text);
							data.cell.clear_output();
					} else {
							var index = that.find_cell_index(data.cell);
							var new_cell = that.insert_cell_below('code',index);
							new_cell.set_text(data.text);
					}
					that.dirty = true;
			});

			this.events.on('unrecognized_cell.Cell', function () {
					that.warn_nbformat_minor();
			});

			this.events.on('unrecognized_output.OutputArea', function () {
					that.warn_nbformat_minor();
			});

			this.events.on('set_dirty.Notebook', function (event, data) {
					that.dirty = data.value;
			});

			this.events.on('trust_changed.Notebook', function (event, trusted) {
					that.trusted = trusted;
			});

			this.events.on('select.Cell', function (event, data) {
					var index = that.find_cell_index(data.cell);
					that.select(index);
			});

			this.events.on('edit_mode.Cell', function (event, data) {
					that.handle_edit_mode(data.cell);
			});

			this.events.on('command_mode.Cell', function (event, data) {
					that.handle_command_mode(data.cell);
			});

			this.events.on('kernel_ready.Kernel', function(event, data) {
					var kinfo = data.kernel.info_reply;
					if (!kinfo.language_info) {
							delete that.metadata.language_info;
							return;
					}
					var langinfo = kinfo.language_info;
					that.metadata.language_info = langinfo;
					// Mode 'null' should be plain, unhighlighted text.
					var cm_mode = langinfo.codemirror_mode || langinfo.name || 'null';
					that.set_codemirror_mode(cm_mode);
			});

			this.events.on('kernel_idle.Kernel', function () {
					that.kernel_busy = false;
			});

			this.events.on('kernel_busy.Kernel', function () {
					that.kernel_busy = true;
			});

			var collapse_time = function (time) {
					var app_height = $('#ipython-main-app').height(); // content height
					var splitter_height = $('div#pager_splitter').outerHeight(true);
					var new_height = app_height - splitter_height;
					that.element.animate({height : new_height + 'px'}, time);
			};

			this.element.bind('collapse_pager', function (event, extrap) {
					var time = (extrap !== undefined) ? ((extrap.duration !== undefined ) ? extrap.duration : 'fast') : 'fast';
					collapse_time(time);
			});

			var expand_time = function (time) {
					var app_height = $('#ipython-main-app').height(); // content height
					var splitter_height = $('div#pager_splitter').outerHeight(true);
					var pager_height = $('div#pager').outerHeight(true);
					var new_height = app_height - pager_height - splitter_height;
					that.element.animate({height : new_height + 'px'}, time);
			};

			this.element.bind('expand_pager', function (event, extrap) {
					var time = (extrap !== undefined) ? ((extrap.duration !== undefined ) ? extrap.duration : 'fast') : 'fast';
					expand_time(time);
			});

			// Firefox 22 broke $(window).on("beforeunload")
			// I'm not sure why or how.
			window.onbeforeunload = function (e) {
					// TODO: Make killing the kernel configurable.
					var kill_kernel = false;
					if (kill_kernel) {
							that.session.delete();
					}
					// if the kernel is busy, prompt the user if he’s sure
					if (that.kernel_busy) {
							return "The Kernel is busy, outputs may be lost.";
					}
					// IE treats null as a string.  Instead just return which will avoid the dialog.
					return;
			};
	};

	/**
	 * Trigger a warning dialog about missing functionality from newer minor versions
	 */
	Notebook.prototype.warn_nbformat_minor = function (event) {
			var v = 'v' + this.nbformat + '.';
			var orig_vs = v + this.nbformat_minor;
			var this_vs = v + this.current_nbformat_minor;
			var msg = "This notebook is version " + orig_vs + ", but we only fully support up to " +
			this_vs + ".  You can still work with this notebook, but cell and output types " +
			"introduced in later notebook versions will not be available.";

			dialog.modal({
					notebook: this,
					keyboard_manager: this.keyboard_manager,
					title : "Newer Notebook",
					body : msg,
					buttons : {
							OK : {
									"class" : "btn-danger"
							}
					}
			});
	};

	/**
	 * Set the dirty flag, and trigger the set_dirty.Notebook event
	 */
	Notebook.prototype.set_dirty = function (value) {
			if (value === undefined) {
					value = true;
			}
			if (this.dirty === value) {
					return;
			}
			this.events.trigger('set_dirty.Notebook', {value: value});
	};

	/**
	 * Scroll the top of the page to a given cell.
	 *
	 * @param {integer}  index - An index of the cell to view
	 * @param {integer}  time - Animation time in milliseconds
	 * @return {integer} Pixel offset from the top of the container
	 */
	Notebook.prototype.scroll_to_cell = function (index, time) {
			return this.scroll_cell_percent(index, 0, time);
	};

	/**
	 * Scroll the middle of the page to a given cell.
	 *
	 * @param {integer}  index - An index of the cell to view
	 * @param {integer}  percent - 0-100, the location on the screen to scroll.
	 *                   0 is the top, 100 is the bottom.
	 * @param {integer}  time - Animation time in milliseconds
	 * @return {integer} Pixel offset from the top of the container
	 */
	Notebook.prototype.scroll_cell_percent = function (index, percent, time) {
			var cells = this.get_cells();
			time = time || 0;
			percent = percent || 0;
			index = Math.min(cells.length-1,index);
			index = Math.max(0             ,index);
			var sme = this.scroll_manager.element;
			var h = sme.height();
			var st = sme.scrollTop();
			var t = sme.offset().top;
			var ct = cells[index].element.offset().top;
			var scroll_value =  st + ct - (t + .01 * percent * h);
			this.scroll_manager.element.animate({scrollTop:scroll_value}, time);
			return scroll_value;
	};

	/**
	 * Scroll to the bottom of the page.
	 */
	Notebook.prototype.scroll_to_bottom = function () {
			this.scroll_manager.element.animate({scrollTop:this.element.get(0).scrollHeight}, 0);
	};

	/**
	 * Scroll to the top of the page.
	 */
	Notebook.prototype.scroll_to_top = function () {
			this.scroll_manager.element.animate({scrollTop:0}, 0);
	};

	// Edit Notebook metadata

	/**
	 * Display a dialog that allows the user to edit the Notebook's metadata.
	 */
	Notebook.prototype.edit_metadata = function () {
			var that = this;
			dialog.edit_metadata({
					md: this.metadata,
					callback: function (md) {
							that.metadata = md;
					},
					name: 'Notebook',
					notebook: this,
					keyboard_manager: this.keyboard_manager});
	};

	// Cell indexing, retrieval, etc.

	/**
	 * Get all cell elements in the notebook.
	 *
	 * @return {jQuery} A selector of all cell elements
	 */
	Notebook.prototype.get_cell_elements = function () {
			return this.container.find(".cell").not('.cell .cell');
	};

	/**
	 * Get a particular cell element.
	 *
	 * @param {integer} index An index of a cell to select
	 * @return {jQuery} A selector of the given cell.
	 */
	Notebook.prototype.get_cell_element = function (index) {
			var result = null;
			var e = this.get_cell_elements().eq(index);
			if (e.length !== 0) {
					result = e;
			}
			return result;
	};

	/**
	 * Try to get a particular cell by msg_id.
	 *
	 * @param {string} msg_id A message UUID
	 * @return {Cell} Cell or null if no cell was found.
	 */
	Notebook.prototype.get_msg_cell = function (msg_id) {
			return codecell.CodeCell.msg_cells[msg_id] || null;
	};

	/**
	 * Count the cells in this notebook.
	 *
	 * @return {integer} The number of cells in this notebook
	 */
	Notebook.prototype.ncells = function () {
			return this.get_cell_elements().length;
	};

	/**
	 * Get all Cell objects in this notebook.
	 *
	 * @return {Array} This notebook's Cell objects
	 */
	Notebook.prototype.get_cells = function () {
			// TODO: we are often calling cells as cells()[i], which we should optimize
			// to cells(i) or a new method.
			return this.get_cell_elements().toArray().map(function (e) {
					return $(e).data("cell");
			});
	};

	/**
	 * Get a Cell objects from this notebook.
	 *
	 * @param {integer} index - An index of a cell to retrieve
	 * @return {Cell} Cell or null if no cell was found.
	 */
	Notebook.prototype.get_cell = function (index) {
			var result = null;
			var ce = this.get_cell_element(index);
			if (ce !== null) {
					result = ce.data('cell');
			}
			return result;
	};

	/**
	 * Get the cell below a given cell.
	 *
	 * @param {Cell} cell
	 * @return {Cell} the next cell or null if no cell was found.
	 */
	Notebook.prototype.get_next_cell = function (cell) {
			var result = null;
			var index = this.find_cell_index(cell);
			if (this.is_valid_cell_index(index+1)) {
					result = this.get_cell(index+1);
			}
			return result;
	};

	/**
	 * Get the cell above a given cell.
	 *
	 * @param {Cell} cell
	 * @return {Cell} The previous cell or null if no cell was found.
	 */
	Notebook.prototype.get_prev_cell = function (cell) {
			var result = null;
			var index = this.find_cell_index(cell);
			if (index !== null && index > 0) {
					result = this.get_cell(index-1);
			}
			return result;
	};

	/**
	 * Get the numeric index of a given cell.
	 *
	 * @param {Cell} cell
	 * @return {integer} The cell's numeric index or null if no cell was found.
	 */
	Notebook.prototype.find_cell_index = function (cell) {
			var result = null;
			this.get_cell_elements().filter(function (index) {
					if ($(this).data("cell") === cell) {
							result = index;
					}
			});
			return result;
	};

	/**
	 * Return given index if defined, or the selected index if not.
	 *
	 * @param {integer} [index] - A cell's index
	 * @return {integer} cell index
	 */
	Notebook.prototype.index_or_selected = function (index) {
			var i;
			if (index === undefined || index === null) {
					i = this.get_selected_index();
					if (i === null) {
							i = 0;
					}
			} else {
					i = index;
			}
			return i;
	};

	/**
	 * Get the currently selected cell.
	 *
	 * @return {Cell} The selected cell
	 */
	Notebook.prototype.get_selected_cell = function () {
			var index = this.get_selected_index();
			return this.get_cell(index);
	};

	/**
	 * Check whether a cell index is valid.
	 *
	 * @param {integer} index - A cell index
	 * @return True if the index is valid, false otherwise
	 */
	Notebook.prototype.is_valid_cell_index = function (index) {
			if (index !== null && index >= 0 && index < this.ncells()) {
					return true;
			} else {
					return false;
			}
	};

	/**
	 * Get the index of the currently selected cell.
	 *
	 * @return {integer} The selected cell's numeric index
	 */
	Notebook.prototype.get_selected_index = function () {
			var result = null;
			this.get_cell_elements().filter(function (index) {
					if ($(this).data("cell").selected === true) {
							result = index;
					}
			});
			return result;
	};


	// Cell selection.

	/**
	 * Programmatically select a cell.
	 *
	 * @param {integer} index - A cell's index
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.select = function (index) {
			if (this.is_valid_cell_index(index)) {
					var sindex = this.get_selected_index();
					if (sindex !== null && index !== sindex) {
							// If we are about to select a different cell, make sure we are
							// first in command mode.
							if (this.mode !== 'command') {
									this.command_mode();
							}
							this.get_cell(sindex).unselect();
					}
					var cell = this.get_cell(index);
					cell.select();
					if (cell.cell_type === 'heading') {
							this.events.trigger('selected_cell_type_changed.Notebook',
									{'cell_type':cell.cell_type,level:cell.level}
							);
					} else {
							this.events.trigger('selected_cell_type_changed.Notebook',
									{'cell_type':cell.cell_type}
							);
					}
			}
			return this;
	};

	/**
	 * Programmatically select the next cell.
	 *
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.select_next = function () {
			var index = this.get_selected_index();
			this.select(index+1);
			return this;
	};

	/**
	 * Programmatically select the previous cell.
	 *
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.select_prev = function () {
			var index = this.get_selected_index();
			this.select(index-1);
			return this;
	};


	// Edit/Command mode

	/**
	 * Gets the index of the cell that is in edit mode.
	 *
	 * @return {integer} index
	 */
	Notebook.prototype.get_edit_index = function () {
			var result = null;
			this.get_cell_elements().filter(function (index) {
					if ($(this).data("cell").mode === 'edit') {
							result = index;
					}
			});
			return result;
	};

	/**
	 * Handle when a a cell blurs and the notebook should enter command mode.
	 *
	 * @param {Cell} [cell] - Cell to enter command mode on.
	 */
	Notebook.prototype.handle_command_mode = function (cell) {
			if (this.mode !== 'command') {
					cell.command_mode();
					this.mode = 'command';
					this.events.trigger('command_mode.Notebook');
					this.keyboard_manager.command_mode();
			}
	};

	/**
	 * Make the notebook enter command mode.
	 */
	Notebook.prototype.command_mode = function () {
			var cell = this.get_cell(this.get_edit_index());
			if (cell && this.mode !== 'command') {
					// We don't call cell.command_mode, but rather blur the CM editor
					// which will trigger the call to handle_command_mode.
					cell.code_mirror.getInputField().blur();
			}
	};

	/**
	 * Handle when a cell fires it's edit_mode event.
	 *
	 * @param {Cell} [cell] Cell to enter edit mode on.
	 */
	Notebook.prototype.handle_edit_mode = function (cell) {
			if (cell && this.mode !== 'edit') {
					cell.edit_mode();
					this.mode = 'edit';
					this.events.trigger('edit_mode.Notebook');
					this.keyboard_manager.edit_mode();
			}
	};

	/**
	 * Make a cell enter edit mode.
	 */
	Notebook.prototype.edit_mode = function () {
			var cell = this.get_selected_cell();
			if (cell && this.mode !== 'edit') {
					cell.unrender();
					cell.focus_editor();
			}
	};

	/**
	 * Ensure either cell, or codemirror is focused. Is none
	 * is focused, focus the cell.
	 */
	Notebook.prototype.ensure_focused = function(){
			var cell = this.get_selected_cell();
			if (cell === null) {return;}  // No cell is selected
			cell.ensure_focused();
	}

	/**
	 * Focus the currently selected cell.
	 */
	Notebook.prototype.focus_cell = function () {
			var cell = this.get_selected_cell();
			if (cell === null) {return;}  // No cell is selected
			cell.focus_cell();
	};

	// Cell movement

	/**
	 * Move given (or selected) cell up and select it.
	 *
	 * @param {integer} [index] - cell index
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.move_cell_up = function (index) {
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i) && i > 0) {
					var pivot = this.get_cell_element(i-1);
					var tomove = this.get_cell_element(i);
					if (pivot !== null && tomove !== null) {
							tomove.detach();
							pivot.before(tomove);
							this.select(i-1);
							var cell = this.get_selected_cell();
							cell.focus_cell();
					}
					this.set_dirty(true);
			}
			return this;
	};


	/**
	 * Move given (or selected) cell down and select it.
	 *
	 * @param {integer} [index] - cell index
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.move_cell_down = function (index) {
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i) && this.is_valid_cell_index(i+1)) {
					var pivot = this.get_cell_element(i+1);
					var tomove = this.get_cell_element(i);
					if (pivot !== null && tomove !== null) {
							tomove.detach();
							pivot.after(tomove);
							this.select(i+1);
							var cell = this.get_selected_cell();
							cell.focus_cell();
					}
			}
			this.set_dirty();
			return this;
	};


	// Insertion, deletion.

	/**
	 * Delete a cell from the notebook without any precautions
	 * Needed to reload checkpoints and other things like that.
	 *
	 * @param {integer} [index] - cell's numeric index
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype._unsafe_delete_cell = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);

			$('#undelete_cell').addClass('disabled');
			if (this.is_valid_cell_index(i)) {
					var old_ncells = this.ncells();
					var ce = this.get_cell_element(i);
					ce.remove();
					this.set_dirty(true);
			}
			return this;
	};

	/**
	 * Delete a cell from the notebook.
	 *
	 * @param {integer} [index] - cell's numeric index
	 * @return {Notebook} This notebook
	 */
	Notebook.prototype.delete_cell = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (!cell.is_deletable()) {
					return this;
			}

			this.undelete_backup = cell.toJSON();
			$('#undelete_cell').removeClass('disabled');
			if (this.is_valid_cell_index(i)) {
					var old_ncells = this.ncells();
					var ce = this.get_cell_element(i);
					ce.remove();
					if (i === 0) {
							// Always make sure we have at least one cell.
							if (old_ncells === 1) {
									this.insert_cell_below('code');
							}
							this.select(0);
							this.undelete_index = 0;
							this.undelete_below = false;
					} else if (i === old_ncells-1 && i !== 0) {
							this.select(i-1);
							this.undelete_index = i - 1;
							this.undelete_below = true;
					} else {
							this.select(i);
							this.undelete_index = i;
							this.undelete_below = false;
					}
					this.events.trigger('delete.Cell', {'cell': cell, 'index': i});
					this.set_dirty(true);
			}
			return this;
	};

	/**
	 * Restore the most recently deleted cell.
	 */
	Notebook.prototype.undelete_cell = function() {
			if (this.undelete_backup !== null && this.undelete_index !== null) {
					var current_index = this.get_selected_index();
					if (this.undelete_index < current_index) {
							current_index = current_index + 1;
					}
					if (this.undelete_index >= this.ncells()) {
							this.select(this.ncells() - 1);
					}
					else {
							this.select(this.undelete_index);
					}
					var cell_data = this.undelete_backup;
					var new_cell = null;
					if (this.undelete_below) {
							new_cell = this.insert_cell_below(cell_data.cell_type);
					} else {
							new_cell = this.insert_cell_above(cell_data.cell_type);
					}
					new_cell.fromJSON(cell_data);
					if (this.undelete_below) {
							this.select(current_index+1);
					} else {
							this.select(current_index);
					}
					this.undelete_backup = null;
					this.undelete_index = null;
			}
			$('#undelete_cell').addClass('disabled');
	};

	/**
	 * Insert a cell so that after insertion the cell is at given index.
	 *
	 * If cell type is not provided, it will default to the type of the
	 * currently active cell.
	 *
	 * Similar to insert_above, but index parameter is mandatory.
	 *
	 * Index will be brought back into the accessible range [0,n].
	 *
	 * @param {string} [type] - in ['code','markdown', 'raw'], defaults to 'code'
	 * @param {integer} [index] - a valid index where to insert cell
	 * @return {Cell|null} created cell or null
	 */
	Notebook.prototype.insert_cell_at_index = function(type, index){

			var ncells = this.ncells();
			index = Math.min(index, ncells);
			index = Math.max(index, 0);
			var cell = null;
			type = type || 'code';
			//this.class_config.get_sync('default_cell_type');
			if (type === 'above') {
					if (index > 0) {
							type = this.get_cell(index-1).cell_type;
					} else {
							type = 'code';
					}
			} else if (type === 'below') {
					if (index < ncells) {
							type = this.get_cell(index).cell_type;
					} else {
							type = 'code';
					}
			} else if (type === 'selected') {
					type = this.get_selected_cell().cell_type;
			}

			if (ncells === 0 || this.is_valid_cell_index(index) || index === ncells) {
					var cell_options = {
							events: this.events,
							config: this.config,
							keyboard_manager: this.keyboard_manager,
							notebook: this,
							tooltip: this.tooltip
					};
					switch(type) {
					case 'code':
							cell = new codecell.CodeCell(this.kernel, cell_options);
							cell.set_input_prompt();
							break;
					case 'markdown':
							cell = new textcell.MarkdownCell(cell_options);
							break;
					case 'raw':
							cell = new textcell.RawCell(cell_options);
							break;
					default:
							console.log("Unrecognized cell type: ", type, cellmod);
							cell = new cellmod.UnrecognizedCell(cell_options);
					}

					if(this._insert_element_at_index(cell.element,index)) {
							cell.render();
							this.events.trigger('create.Cell', {'cell': cell, 'index': index});
							cell.refresh();
							// We used to select the cell after we refresh it, but there
							// are now cases were this method is called where select is
							// not appropriate. The selection logic should be handled by the
							// caller of the the top level insert_cell methods.
							this.set_dirty(true);
					}
			}
			return cell;

	};

	/**
	 * Insert an element at given cell index.
	 *
	 * @param {HTMLElement} element - a cell element
	 * @param {integer}     [index] - a valid index where to inser cell
	 * @returns {boolean}   success
	 */
	Notebook.prototype._insert_element_at_index = function(element, index){
			if (element === undefined){
					return false;
			}

			var ncells = this.ncells();

			if (ncells === 0) {
					// special case append if empty
					this.container.append(element);
			} else if ( ncells === index ) {
					// special case append it the end, but not empty
					this.get_cell_element(index-1).after(element);
			} else if (this.is_valid_cell_index(index)) {
					// otherwise always somewhere to append to
					this.get_cell_element(index).before(element);
			} else {
					return false;
			}

			if (this.undelete_index !== null && index <= this.undelete_index) {
					this.undelete_index = this.undelete_index + 1;
					this.set_dirty(true);
			}
			return true;
	};

	/**
	 * Insert a cell of given type above given index, or at top
	 * of notebook if index smaller than 0.
	 *
	 * @param {string}     [type] - cell type
	 * @param {integer}    [index] - defaults to the currently selected cell
	 * @return {Cell|null} handle to created cell or null
	 */
	Notebook.prototype.insert_cell_above = function (type, index) {
			index = this.index_or_selected(index);
			return this.insert_cell_at_index(type, index);
	};

	/**
	 * Insert a cell of given type below given index, or at bottom
	 * of notebook if index greater than number of cells
	 *
	 * @param {string}     [type] - cell type
	 * @param {integer}    [index] - defaults to the currently selected cell
	 * @return {Cell|null} handle to created cell or null
	 */
	Notebook.prototype.insert_cell_below = function (type, index) {
			index = this.index_or_selected(index);
			return this.insert_cell_at_index(type, index+1);
	};


	/**
	 * Insert cell at end of notebook
	 *
	 * @param {string} type - cell type
	 * @return {Cell|null} handle to created cell or null
	 */
	Notebook.prototype.insert_cell_at_bottom = function (type){
			var len = this.ncells();
			return this.insert_cell_below(type,len-1);
	};

	/**
	 * Turn a cell into a code cell.
	 *
	 * @param {integer} [index] - cell index
	 */
	Notebook.prototype.to_code = function (index) {
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i)) {
					var source_cell = this.get_cell(i);
					if (!(source_cell instanceof codecell.CodeCell)) {
							var target_cell = this.insert_cell_below('code',i);
							var text = source_cell.get_text();
							if (text === source_cell.placeholder) {
									text = '';
							}
							//metadata
							target_cell.metadata = source_cell.metadata;

							target_cell.set_text(text);
							// make this value the starting point, so that we can only undo
							// to this state, instead of a blank cell
							target_cell.code_mirror.clearHistory();
							source_cell.element.remove();
							this.select(i);
							var cursor = source_cell.code_mirror.getCursor();
							target_cell.code_mirror.setCursor(cursor);
							this.set_dirty(true);
					}
			}
	};

	/**
	 * Turn a cell into a Markdown cell.
	 *
	 * @param {integer} [index] - cell index
	 */
	Notebook.prototype.to_markdown = function (index) {
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i)) {
					var source_cell = this.get_cell(i);

					if (!(source_cell instanceof textcell.MarkdownCell)) {
							var target_cell = this.insert_cell_below('markdown',i);
							var text = source_cell.get_text();

							if (text === source_cell.placeholder) {
									text = '';
							}
							// metadata
							target_cell.metadata = source_cell.metadata;
							// We must show the editor before setting its contents
							target_cell.unrender();
							target_cell.set_text(text);
							// make this value the starting point, so that we can only undo
							// to this state, instead of a blank cell
							target_cell.code_mirror.clearHistory();
							source_cell.element.remove();
							this.select(i);
							if ((source_cell instanceof textcell.TextCell) && source_cell.rendered) {
									target_cell.render();
							}
							var cursor = source_cell.code_mirror.getCursor();
							target_cell.code_mirror.setCursor(cursor);
							this.set_dirty(true);
					}
			}
	};

	/**
	 * Turn a cell into a raw text cell.
	 *
	 * @param {integer} [index] - cell index
	 */
	Notebook.prototype.to_raw = function (index) {
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i)) {
					var target_cell = null;
					var source_cell = this.get_cell(i);

					if (!(source_cell instanceof textcell.RawCell)) {
							target_cell = this.insert_cell_below('raw',i);
							var text = source_cell.get_text();
							if (text === source_cell.placeholder) {
									text = '';
							}
							//metadata
							target_cell.metadata = source_cell.metadata;
							// We must show the editor before setting its contents
							target_cell.unrender();
							target_cell.set_text(text);
							// make this value the starting point, so that we can only undo
							// to this state, instead of a blank cell
							target_cell.code_mirror.clearHistory();
							source_cell.element.remove();
							this.select(i);
							var cursor = source_cell.code_mirror.getCursor();
							target_cell.code_mirror.setCursor(cursor);
							this.set_dirty(true);
					}
			}
	};

	/**
	 * Warn about heading cell support removal.
	 */
	Notebook.prototype._warn_heading = function () {
			dialog.modal({
					notebook: this,
					keyboard_manager: this.keyboard_manager,
					title : "Use markdown headings",
					body : $("<p/>").text(
							'Jupyter no longer uses special heading cells. ' +
							'Instead, write your headings in Markdown cells using # characters:'
					).append($('<pre/>').text(
							'## This is a level 2 heading'
					)),
					buttons : {
							"OK" : {}
					}
			});
	};

	/**
	 * Turn a cell into a heading containing markdown cell.
	 *
	 * @param {integer} [index] - cell index
	 * @param {integer} [level] - heading level (e.g., 1 for h1)
	 */
	Notebook.prototype.to_heading = function (index, level) {
			this.to_markdown(index);
			level = level || 1;
			var i = this.index_or_selected(index);
			if (this.is_valid_cell_index(i)) {
					var cell = this.get_cell(i);
					cell.set_heading_level(level);
					this.set_dirty(true);
			}
	};


	// Cut/Copy/Paste

	/**
	 * Enable the UI elements for pasting cells.
	 */
	Notebook.prototype.enable_paste = function () {
			var that = this;
			if (!this.paste_enabled) {
					$('#paste_cell_replace').removeClass('disabled')
							.on('click', function () {that.paste_cell_replace();});
					$('#paste_cell_above').removeClass('disabled')
							.on('click', function () {that.paste_cell_above();});
					$('#paste_cell_below').removeClass('disabled')
							.on('click', function () {that.paste_cell_below();});
					this.paste_enabled = true;
			}
	};

	/**
	 * Disable the UI elements for pasting cells.
	 */
	Notebook.prototype.disable_paste = function () {
			if (this.paste_enabled) {
					$('#paste_cell_replace').addClass('disabled').off('click');
					$('#paste_cell_above').addClass('disabled').off('click');
					$('#paste_cell_below').addClass('disabled').off('click');
					this.paste_enabled = false;
			}
	};

	/**
	 * Cut a cell.
	 */
	Notebook.prototype.cut_cell = function () {
			this.copy_cell();
			this.delete_cell();
	};

	/**
	 * Copy a cell.
	 */
	Notebook.prototype.copy_cell = function () {
			var cell = this.get_selected_cell();
			this.clipboard = cell.toJSON();
			// remove undeletable status from the copied cell
			if (this.clipboard.metadata.deletable !== undefined) {
					delete this.clipboard.metadata.deletable;
			}
			this.enable_paste();
	};

	/**
	 * Replace the selected cell with the cell in the clipboard.
	 */
	Notebook.prototype.paste_cell_replace = function () {
			if (this.clipboard !== null && this.paste_enabled) {
					var cell_data = this.clipboard;
					var new_cell = this.insert_cell_above(cell_data.cell_type);
					new_cell.fromJSON(cell_data);
					var old_cell = this.get_next_cell(new_cell);
					this.delete_cell(this.find_cell_index(old_cell));
					this.select(this.find_cell_index(new_cell));
			}
	};

	/**
	 * Paste a cell from the clipboard above the selected cell.
	 */
	Notebook.prototype.paste_cell_above = function () {
			if (this.clipboard !== null && this.paste_enabled) {
					var cell_data = this.clipboard;
					var new_cell = this.insert_cell_above(cell_data.cell_type);
					new_cell.fromJSON(cell_data);
					new_cell.focus_cell();
			}
	};

	/**
	 * Paste a cell from the clipboard below the selected cell.
	 */
	Notebook.prototype.paste_cell_below = function () {
			if (this.clipboard !== null && this.paste_enabled) {
					var cell_data = this.clipboard;
					var new_cell = this.insert_cell_below(cell_data.cell_type);
					new_cell.fromJSON(cell_data);
					new_cell.focus_cell();
			}
	};

	// Split/merge

	/**
	 * Split the selected cell into two cells.
	 */
	Notebook.prototype.split_cell = function () {
			var cell = this.get_selected_cell();
			if (cell.is_splittable()) {
					var texta = cell.get_pre_cursor();
					var textb = cell.get_post_cursor();
					cell.set_text(textb);
					var new_cell = this.insert_cell_above(cell.cell_type);
					// Unrender the new cell so we can call set_text.
					new_cell.unrender();
					new_cell.set_text(texta);
			}
	};

	/**
	 * Merge the selected cell into the cell above it.
	 */
	Notebook.prototype.merge_cell_above = function () {
			var index = this.get_selected_index();
			var cell = this.get_cell(index);
			var render = cell.rendered;
			if (!cell.is_mergeable()) {
					return;
			}
			if (index > 0) {
					var upper_cell = this.get_cell(index-1);
					if (!upper_cell.is_mergeable()) {
							return;
					}
					var upper_text = upper_cell.get_text();
					var text = cell.get_text();
					if (cell instanceof codecell.CodeCell) {
							cell.set_text(upper_text+'\n'+text);
					} else {
							cell.unrender(); // Must unrender before we set_text.
							cell.set_text(upper_text+'\n\n'+text);
							if (render) {
									// The rendered state of the final cell should match
									// that of the original selected cell;
									cell.render();
							}
					}
					this.delete_cell(index-1);
					this.select(this.find_cell_index(cell));
			}
	};

	/**
	 * Merge the selected cell into the cell below it.
	 */
	Notebook.prototype.merge_cell_below = function () {
			var index = this.get_selected_index();
			var cell = this.get_cell(index);
			var render = cell.rendered;
			if (!cell.is_mergeable()) {
					return;
			}
			if (index < this.ncells()-1) {
					var lower_cell = this.get_cell(index+1);
					if (!lower_cell.is_mergeable()) {
							return;
					}
					var lower_text = lower_cell.get_text();
					var text = cell.get_text();
					if (cell instanceof codecell.CodeCell) {
							cell.set_text(text+'\n'+lower_text);
					} else {
							cell.unrender(); // Must unrender before we set_text.
							cell.set_text(text+'\n\n'+lower_text);
							if (render) {
									// The rendered state of the final cell should match
									// that of the original selected cell;
									cell.render();
							}
					}
					this.delete_cell(index+1);
					this.select(this.find_cell_index(cell));
			}
	};


	// Cell collapsing and output clearing

	/**
	 * Hide a cell's output.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.collapse_output = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.collapse_output();
					this.set_dirty(true);
			}
	};

	/**
	 * Hide each code cell's output area.
	 */
	Notebook.prototype.collapse_all_output = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.collapse_output();
					}
			});
			// this should not be set if the `collapse` key is removed from nbformat
			this.set_dirty(true);
	};

	/**
	 * Show a cell's output.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.expand_output = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.expand_output();
					this.set_dirty(true);
			}
	};

	/**
	 * Expand each code cell's output area, and remove scrollbars.
	 */
	Notebook.prototype.expand_all_output = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.expand_output();
					}
			});
			// this should not be set if the `collapse` key is removed from nbformat
			this.set_dirty(true);
	};

	/**
	 * Clear the selected CodeCell's output area.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.clear_output = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.clear_output();
					this.set_dirty(true);
			}
	};

	/**
	 * Clear each code cell's output area.
	 */
	Notebook.prototype.clear_all_output = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.clear_output();
					}
			});
			this.set_dirty(true);
	};

	/**
	 * Scroll the selected CodeCell's output area.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.scroll_output = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.scroll_output();
					this.set_dirty(true);
			}
	};

	/**
	 * Expand each code cell's output area and add a scrollbar for long output.
	 */
	Notebook.prototype.scroll_all_output = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.scroll_output();
					}
			});
			// this should not be set if the `collapse` key is removed from nbformat
			this.set_dirty(true);
	};

	/**
	 * Toggle whether a cell's output is collapsed or expanded.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.toggle_output = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.toggle_output();
					this.set_dirty(true);
			}
	};

	/**
	 * Toggle the output of all cells.
	 */
	Notebook.prototype.toggle_all_output = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.toggle_output();
					}
			});
			// this should not be set if the `collapse` key is removed from nbformat
			this.set_dirty(true);
	};

	/**
	 * Toggle a scrollbar for long cell outputs.
	 *
	 * @param {integer} index - cell index
	 */
	Notebook.prototype.toggle_output_scroll = function (index) {
			var i = this.index_or_selected(index);
			var cell = this.get_cell(i);
			if (cell !== null && (cell instanceof codecell.CodeCell)) {
					cell.toggle_output_scroll();
					this.set_dirty(true);
			}
	};

	/**
	 * Toggle the scrolling of long output on all cells.
	 */
	Notebook.prototype.toggle_all_output_scroll = function () {
			this.get_cells().map(function (cell, i) {
					if (cell instanceof codecell.CodeCell) {
							cell.toggle_output_scroll();
					}
			});
			// this should not be set if the `collapse` key is removed from nbformat
			this.set_dirty(true);
	};

	// Other cell functions: line numbers, ...

	/**
	 * Toggle line numbers in the selected cell's input area.
	 */
	Notebook.prototype.cell_toggle_line_numbers = function() {
			this.get_selected_cell().toggle_line_numbers();
	};


	//dispatch codemirror mode to all cells.
	Notebook.prototype._dispatch_mode = function(spec, newmode){
			this.codemirror_mode = newmode;
			codecell.CodeCell.options_default.cm_config.mode = newmode;
			this.get_cells().map(function(cell, i) {
					if (cell.cell_type === 'code'){
							cell.code_mirror.setOption('mode', spec);
							// This is currently redundant, because cm_config ends up as
							// codemirror's own .options object, but I don't want to
							// rely on that.
							cell._options.cm_config.mode = spec;
					}
			});

	};

	// roughly try to check mode equality
	var _mode_equal = function(mode1, mode2){
			return ((mode1||{}).name||mode1)===((mode2||{}).name||mode2);
	};

	/**
	 * Set the codemirror mode for all code cells, including the default for
	 * new code cells.
	 * Set the mode to 'null' (no highlighting) if it can't be found.
	 */
	Notebook.prototype.set_codemirror_mode = function(newmode){
			// if mode is the same don't reset,
			// to avoid n-time re-highlighting.
			if (_mode_equal(newmode, this.codemirror_mode)) {
					return;
			}

			var that = this;
			utils.requireCodeMirrorMode(newmode, function (spec) {
					that._dispatch_mode(spec, newmode);
			}, function(){
					// on error don't dispatch the new mode as re-setting it later will not work.
					// don't either set to null mode if it has been changed in the meantime
					if( _mode_equal(newmode, this.codemirror_mode) ){
							that._dispatch_mode('null','null');
					}
			});
	};

	/**
	 * Load a notebook from JSON (.ipynb).
	 *
	 * @param {object} data - JSON representation of a notebook
	 */
	Notebook.prototype.fromJSON = function (data) {

			var content = data.content;
			var ncells = this.ncells();
			var i;
			for (i=0; i<ncells; i++) {
					// Always delete cell 0 as they get renumbered as they are deleted.
					this._unsafe_delete_cell(0);
			}
			// Save the metadata and name.
			this.metadata = content.metadata;
			this.notebook_name = data.name;
			this.notebook_path = data.path;
			var trusted = true;

			// Set the codemirror mode from language_info metadata
			if (this.metadata.language_info !== undefined) {
					var langinfo = this.metadata.language_info;
					// Mode 'null' should be plain, unhighlighted text.
					var cm_mode = langinfo.codemirror_mode || langinfo.name || 'null';
					this.set_codemirror_mode(cm_mode);
			}

			var new_cells = content.cells;
			ncells = new_cells.length;
			var cell_data = null;
			var new_cell = null;
			for (i=0; i<ncells; i++) {
					cell_data = new_cells[i];
					new_cell = this.insert_cell_at_index(cell_data.cell_type, i);
					new_cell.fromJSON(cell_data);
					if (new_cell.cell_type === 'code' && !new_cell.output_area.trusted) {
							trusted = false;
					}
			}
			if (trusted !== this.trusted) {
					this.trusted = trusted;
					this.events.trigger("trust_changed.Notebook", trusted);
			}
	};

	/**
	 * Dump this notebook into a JSON-friendly object.
	 *
	 * @return {object} A JSON-friendly representation of this notebook.
	 */
	Notebook.prototype.toJSON = function () {
			// remove the conversion indicator, which only belongs in-memory
			delete this.metadata.orig_nbformat;
			delete this.metadata.orig_nbformat_minor;

			var cells = this.get_cells();
			var ncells = cells.length;
			var cell_array = new Array(ncells);
			var trusted = true;
			for (var i=0; i<ncells; i++) {
					var cell = cells[i];
					if (cell.cell_type === 'code' && !cell.output_area.trusted) {
							trusted = false;
					}
					cell_array[i] = cell.toJSON();
			}
			var data = {
					cells: cell_array,
					metadata: this.metadata,
					nbformat: this.nbformat,
					nbformat_minor: this.nbformat_minor
			};
			if (trusted !== this.trusted) {
					this.trusted = trusted;
					this.events.trigger("trust_changed.Notebook", trusted);
			}
			return data;
	};

	/**
	 * Ensure a filename has the right extension
	 * Returns the filename with the appropriate extension, appending if necessary.
	 */
	Notebook.prototype.ensure_extension = function (name) {
			var ext = utils.splitext(this.notebook_path)[1];
			if (ext.length && name.slice(-ext.length) !== ext) {
					name = name + ext;
			}
			return name;
	};

	/**
	 * Request a notebook's data from the server.
	 *
	 * @param {string} notebook_path - A notebook to load
	 */
	Notebook.prototype.load_notebook = function (notebook_path) {
			this.events.trigger('notebook_loading.Notebook');

			utils.promising_ajax(notebook_path, {
					processData : false,
					type : "GET",
					dataType : "json",
			}).then(
					$.proxy(this.load_notebook_success, this),
					$.proxy(this.load_notebook_error, this)
			);
	};

	/**
	 * Success callback for loading a notebook from the server.
	 *
	 * Load notebook data from the JSON response.
	 *
	 * @param {object} data JSON representation of a notebook
	 */
	Notebook.prototype.load_notebook_success = function (data) {
			var failed, msg;

			data = {
							type: 'notebook',
							created: '',
							'last_modified': '',
							name: '',
							writable: false,
							path: '',
							content: data,
							mimetype: null,
							format: 'json'
			};
			try {
					this.fromJSON(data);
			} catch (e) {
					failed = e;
					console.log("Notebook failed to load from JSON:", e);
			}
			if (failed || data.message) {
					// *either* fromJSON failed or validation failed
					var body = $("<div>");
					var title;
					if (failed) {
							title = "Notebook failed to load";
							body.append($("<p>").text(
									"The error was: "
							)).append($("<div>").addClass("js-error").text(
									failed.toString()
							)).append($("<p>").text(
									"See the error console for details."
							));
					} else {
							title = "Notebook validation failed";
					}

					if (data.message) {
							if (failed) {
									msg = "The notebook also failed validation:";
							} else {
									msg = "An invalid notebook may not function properly." +
									" The validation error was:";
							}
							body.append($("<p>").text(
									msg
							)).append($("<div>").addClass("validation-error").append(
									$("<pre>").text(data.message)
							));
					}

					dialog.modal({
							notebook: this,
							keyboard_manager: this.keyboard_manager,
							title: title,
							body: body,
							buttons : {
									OK : {
											"class" : "btn-primary"
									}
							}
					});
			}
			if (this.ncells() === 0) {
					this.insert_cell_below('code');
					this.edit_mode(0);
			} else {
					this.select(0);
					this.handle_command_mode(this.get_cell(0));
			}
			this.set_dirty(false);
			this.scroll_to_top();
			this.writable = data.writable || false;
			this.last_modified = new Date(data.last_modified);
			var nbmodel = data.content;
			var orig_nbformat = nbmodel.metadata.orig_nbformat;
			var orig_nbformat_minor = nbmodel.metadata.orig_nbformat_minor;
			if (orig_nbformat !== undefined && nbmodel.nbformat !== orig_nbformat) {
					var src;
					if (nbmodel.nbformat > orig_nbformat) {
							src = " an older notebook format ";
					} else {
							src = " a newer notebook format ";
					}

					msg = "This notebook has been converted from" + src +
					"(v"+orig_nbformat+") to the current notebook " +
					"format (v"+nbmodel.nbformat+"). The next time you save this notebook, the " +
					"current notebook format will be used.";

					if (nbmodel.nbformat > orig_nbformat) {
							msg += " Older versions of Jupyter may not be able to read the new format.";
					} else {
							msg += " Some features of the original notebook may not be available.";
					}
					msg += " To preserve the original version, close the " +
							"notebook without saving it.";
					dialog.modal({
							notebook: this,
							keyboard_manager: this.keyboard_manager,
							title : "Notebook converted",
							body : msg,
							buttons : {
									OK : {
											class : "btn-primary"
									}
							}
					});
			} else if (this.nbformat_minor < nbmodel.nbformat_minor) {
					this.nbformat_minor = nbmodel.nbformat_minor;
			}

			// load toolbar state
			if (this.metadata.celltoolbar) {
					celltoolbar.CellToolbar.global_show();
					celltoolbar.CellToolbar.activate_preset(this.metadata.celltoolbar);
			} else {
					celltoolbar.CellToolbar.global_hide();
			}

			// now that we're fully loaded, it is safe to restore save functionality
			this._fully_loaded = true;
			this.events.trigger('notebook_loaded.Notebook');
	};

	/**
	 * Failure callback for loading a notebook from the server.
	 *
	 * @param {Error} error
	 */
	Notebook.prototype.load_notebook_error = function (error) {
			this.events.trigger('notebook_load_failed.Notebook', error);
			var msg;
			if (error.name === utils.XHR_ERROR && error.xhr.status === 500) {
					utils.log_ajax_error(error.xhr, error.xhr_status, error.xhr_error);
					msg = "An unknown error occurred while loading this notebook. " +
					"This version can load notebook formats " +
					"v" + this.nbformat + " or earlier. See the server log for details.";
			} else {
					msg = error.message;
					console.warn('Error stack trace while loading notebook was:');
					console.warn(error.stack);
			}
			dialog.modal({
					notebook: this,
					keyboard_manager: this.keyboard_manager,
					title: "Error loading notebook",
					body : msg,
					buttons : {
							"OK": {}
					}
			});
	};

	return {'Notebook': Notebook};
})();

IPython.utils = baseJsUtils;
IPython.security = baseJsSecurity;
IPython.keyboard = baseJsKeyboard;
IPython.dialog = baseJsDialog;
IPython.mathjaxutils = notebookJsMathjaxutils;
IPython.CommManager = servicesKernelsComm.CommManager;
IPython.Comm = servicesKernelsComm.Comm;
IPython.Kernel = servicesKernelsKernel.Kernel;
IPython.Session = servicesSessionsSession.Session;
IPython.page = baseJsPage.Page;
IPython.TextCell = notebookJsTextCell.TextCell;
IPython.OutputArea = notebookJsOutputarea.OutputArea;
IPython.KeyboardManager = notebookJsKeyboardManager.KeyboardManager;
IPython.Completer = notebookJsCompleter.Completer;
IPython.Notebook = notebookJsNotebook.Notebook;
IPython.Tooltip = notebookJsTooltip.Tooltip;
IPython.Pager = notebookJsPager.Pager;
IPython.MarkdownCell = notebookJsTextCell.MarkdownCell;
IPython.RawCell = notebookJsTextCell.RawCell;
IPython.Cell = notebookJsCell.Cell;
// IPython.NotebookTour = notebookjst
