var page = baseJsPage;
var events = baseJsEvent;
var pager = notebookJsPager;
var actions = notebookJsAction;
var contents = notebookContents;
var notebook = notebookJsNotebook;
var keyboardManager = notebookJsKeyboardManager;
var pageIns = new page.Page();
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

var notebookIns = new notebook.Notebook('#notebook', {
    events: events,
    keyboard_manager: keyboard_manager,
    contents: contentsIns,
    config: {},
    ws_url: '',
    base_url: '',
    notebook_path: '',
    notebook_name: ''
});

keyboard_manager.set_notebook(notebookIns);

pageIns.show();

var first_load = function() {
    var hash = document.location.hash;
    if (hash) {
        document.location.hash = '';
        document.location.hash = hash;
    }
    // only do this once
    events.off('notebook_loaded.Notebook', first_load);

    $('.js-notebook-placeholder').remove();
};
events.on('notebook_loaded.Notebook', first_load);

IPython.page = pageIns;
IPython.notebook = notebookIns;
IPython.contents = contentsIns;
IPython.pager = pagerIns;
IPython.keyboard_manager = keyboard_manager;
IPython.tooltip = notebookIns.tooltip;

events.trigger('app_initialized.NotebookApp');

notebookIns.load_notebook('/static/notebook.json');