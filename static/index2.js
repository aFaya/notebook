require([
    'base/js/namespace',
    'notebook/js/notebook',
    'contents',
    'base/js/page',
    'base/js/events',
    'notebook/js/pager',
    'notebook/js/actions',
    'notebook/js/keyboardmanager',
    'codemirror/lib/codemirror'
], function(
    IPython,
    notebook,
    contents,
    page,
    events,
    pager,
    actions,
    keyboardmanager,
    CodeMirror
) {
    "use strict";

    // compat with old IPython, remove for IPython > 3.0
    window.CodeMirror = CodeMirror;

    var pageIns = new page.Page();
    var pagerIns = new pager.Pager('div#pager', {
        events: events
    });
    var acts = new actions.init();
    var keyboard_manager = new keyboardmanager.KeyboardManager({
        pager: pagerIns,
        events: events,
        actions: acts
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

    notebookIns.load_notebook('notebook.json');
});