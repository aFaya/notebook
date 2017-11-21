// require([
//     'base/js/namespace',
//     'notebook/js/notebook',
//     'contents',
//     'base/js/page',
//     'base/js/events',
//     'notebook/js/pager',
//     'notebook/js/actions',
//     'notebook/js/keyboardmanager',
//     'codemirror/lib/codemirror'
// ], function (
//     IPython,
//     notebook,
//     contents,
//     page,
//     events,
//     pager,
//     actions,
//     keyboardmanager,
//     CodeMirror
// ) {
//     "use strict";

//     var pageIns = new baseJsPage().Page();
//     var pagerIns = new notebookJsPager().Pager('div#pager', {
//         events: events
//     });
//     var acts = new notebookJsAction().init();
//     var keyboard_manager = new notebookJsKeyboardManager().KeyboardManager({
//         pager: pagerIns,
//         events: events,
//         actions: acts
//     });
//     console.log(notebook);
// })


// var IPython = require('base/js/namespace');
// var utils = require('base/js/utils');
// var dialog = require('base/js/dialog');
// var cellmod = require('notebook/js/cell');
// var textcell = require('notebook/js/textcell');
// var codecell = require('notebook/js/codecell');
// var moment = require('moment');
// var configmod = require('services/config');
// var session = require('services/sessions/session');
// var celltoolbar = require('notebook/js/celltoolbar');
// var marked = require('components/marked/lib/marked');
// var CodeMirror = require('codemirror/lib/codemirror');
// var runMode = require('codemirror/addon/runmode/runmode');
// var mathjaxutils = require('notebook/js/mathjaxutils');
// var keyboard = require('base/js/keyboard');
// var tooltip = require('notebook/js/tooltip');
// var default_celltoolbar = require('notebook/js/celltoolbarpresets/default');
// var rawcell_celltoolbar = require('notebook/js/celltoolbarpresets/rawcell');
// var slideshow_celltoolbar = require('notebook/js/celltoolbarpresets/slideshow');
// var scrollmanager = require('notebook/js/scrollmanager');



var page = baseJsPage();
var events = baseJsEvent();
var pager = notebookJsPager();
var pageIns = new page.Page();
var actions = notebookJsAction();
var contents = notebookContents();
var keyboardManager = notebookJsKeyboardManager();
var pagerIns = new pager.Pager('div#pager', {
    events: events
});
var actions = new actions.init();
var keyboard_manager = new keyboardManager.KeyboardManager({
    pager: pagerIns,
    events: events,
    actions: actions
});
var contentsIns = new contents.Contents({
    base_url: '',
    common_config: {}
});