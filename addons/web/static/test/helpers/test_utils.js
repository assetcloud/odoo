odoo.define('web.test_utils', function (require) {
"use strict";

/**
 * Test Utils
 *
 * In this module, we define various utility functions to help simulate a mock
 * environment as close as possible as a real environment.  The main function is
 * certainly createView, which takes a bunch of parameters and give you back an
 * instance of a view, appended in the dom, ready to be tested.
 */

var AbstractField = require('web.AbstractField');
var config = require('web.config');
var core = require('web.core');
var session = require('web.session');
var MockServer = require('web.MockServer');
var Widget = require('web.Widget');


/**
 * intercepts an event bubbling up the widget hierarchy. The event intercepted
 * must be a "custom event", i.e. an event generated by the method 'trigger_up'.
 *
 * Note that this method really intercepts the event.  It will not be propagated
 * further, and even the handlers on the target will not fire.
 *
 * @param {Widget} widget the target widget (any Odoo widget)
 * @param {string} eventName description of the event
 * @param {function} fn callback executed when the even is intercepted
 */
function intercept(widget, eventName, fn) {
    var _trigger_up = widget._trigger_up.bind(widget);
    widget._trigger_up = function (event) {
        if (event.name === eventName) {
            fn(event);
        } else {
            _trigger_up(event);
        }
    };
}

/**
 * logs all event going through the target widget.
 *
 * @param {Widget} widget
 */
function observe(widget) {
    var _trigger_up = widget._trigger_up.bind(widget);
    widget._trigger_up = function (event) {
        console.log('%c[event] ' + event.name, 'color: blue; font-weight: bold;', event);
        _trigger_up(event);
    };
}

/**
 * create a view synchronously.  This method uses the createAsyncView method.
 * Most views are synchronous, so the deferred can be resolved immediately and
 * this method will work.
 *
 * Be careful, if for some reason a view is async, this method will crash.
 * @see createAsyncView
 *
 * @param {Object} params will be given to createAsyncView
 * @returns {AbstractView}
 */
function createView(params) {
    var view;
    createAsyncView(params).then(function (result) {
        view = result;
    });
    if (!view) {
        throw "The view that you are trying to create is async. Please use createAsyncView instead";
    }
    return view;
}

/**
 * create a view from various parameters.  Here, a view means a javascript
 * instance of an AbstractView class, such as a form view, a list view or a
 * kanban view.
 *
 * It returns the instance of the view, properly created, with all rpcs going
 * through a mock method using the data object as source, and already loaded/
 * started (with a do_search).  The buttons/pager should also be created, if
 * appropriate.
 *
 * Most views can be tested synchronously (@see createView), but some view have
 * external dependencies (like lazy loaded libraries). In that case, it is
 * necessary to use this method.
 *
 * @param {Object} params
 * @param {string} params.arch the xml (arch) of the view to be instantiated
 * @param {any[]} [params.domain] the initial domain for the view
 * @param {Object} [params.context] the initial context for the view
 * @param {Object} [params.debug=false] if true, the widget will be appended in
 *   the DOM. Also, the logLevel will be forced to 2 and the uncaught OdooEvent
 *   will be logged
 * @param {string[]} [params.groupBy] the initial groupBy for the view
 * @param {integer} [params.fieldDebounce=0] the debounce value to use for the
 *   duration of the test.
 * @param {AbstractView} params.View the class that will be instantiated
 * @param {string} params.model a model name, will be given to the view
 * @param {Object} params.intercepts an object with event names as key, and
 *   callback as value.  Each key,value will be used to intercept the event.
 *   Note that this is particularly useful if you want to intercept events going
 *   up in the init process of the view, because there are no other way to do it
 *   after this method returns
 * @returns {Deferred<AbstractView>} resolves with the instance of the view
 */
function createAsyncView(params) {
    var $target = $('#qunit-fixture');
    var widget = new Widget();

    // handle debug parameter: render target, log stuff, ...
    if (params.debug) {
        $target = $('body');
        params.logLevel = 2;
        observe(widget);
        var separator = window.location.href.indexOf('?') !== -1 ? "&" : "?";
        var url = window.location.href + separator + 'testId=' + QUnit.config.current.testId;
        console.log('%c[debug] debug mode activated', 'color: blue; font-weight: bold;', url);
        $target.addClass('debug');
    }

    // add mock environment: mock server, session, fieldviewget, ...
    var mockServer = addMockEnvironment(widget, params);
    var viewInfo = mockServer.fieldsViewGet(params.arch, params.model);

    // create the view
    var viewOptions = {
        modelName: params.model || 'foo',
        ids: 'res_id' in params ? [params.res_id] : undefined,
        currentId: 'res_id' in params ? params.res_id : undefined,
        domain: params.domain || [],
        context: params.context || {},
        groupBy: params.groupBy || [],
    };

    _.extend(viewOptions, params.viewOptions);

    var view = new params.View(viewInfo, viewOptions);

    // make sure images do not trigger a GET on the server
    $('#qunit-fixture').on('DOMNodeInserted.removeSRC', function () {
        removeSrcAttribute($(this), widget);
    });

    // reproduce the DOM environment of views
    var $web_client = $('<div>').addClass('o_web_client').appendTo($target);
    var $control_panel = $('<div>').addClass('o_control_panel').appendTo($web_client);
    var $content = $('<div>').addClass('o_content').appendTo($web_client);
    var $view_manager = $('<div>').addClass('o_view_manager_content').appendTo($content);

    // make sure all Odoo events bubbling up are intercepted
    if (params.intercepts) {
        _.each(params.intercepts, function (cb, name) {
            intercept(widget, name, cb);
        });
    }

    return view.getController(widget).then(function (view) {
        // override the view's 'destroy' so that it calls 'destroy' on the widget
        // instead, as the widget is the parent of the view and the mockServer.
        view.destroy = function () {
            // remove the override to properly destroy the view and its children
            // when it will be called the second time (by its parent)
            delete view.destroy;
            widget.destroy();
            $('#qunit-fixture').off('DOMNodeInserted.removeSRC');
        };
        return view.appendTo($view_manager).then(function () {
            view.$el.on('click', 'a', function (ev) {
                ev.preventDefault();
            });
        }).then(function () {
            var $buttons = $('<div>');
            view.renderButtons($buttons);
            $buttons.contents().appendTo($control_panel);

            var $sidebar = $('<div>');
            view.renderSidebar($sidebar);
            $sidebar.contents().appendTo($control_panel);

            var $pager = $('<div>');
            view.renderPager($pager);
            $pager.contents().appendTo($control_panel);

            return view;
        });
    });
}

/**
 * Add a mock environment to a widget.  This helper function can simulate
 * various kind of side effects, such as mocking RPCs, changing the session,
 * or the translation settings.
 *
 * The simulated environment lasts for the lifecycle of the widget, meaning it
 * disappears when the widget is destroyed.  It is particularly relevant for the
 * session mocks, because the previous session is restored during the destroy
 * call.  So, it means that you have to be careful and make sure that it is
 * properly destroyed before another test is run, otherwise you risk having
 * interferences between tests.
 *
 * @param {Widget} widget
 * @param {Object} params
 * @param {Object} [params.archs] a map of string [model,view_id,view_type] to
 *   a arch object. It is used to mock answers to 'load_views' custom events.
 *   This is useful when the widget instantiate a formview dialog that needs
 *   to load a particular arch.
 * @param {string} [params.currentDate] a string representation of the current
 *   date. It is given to the mock server.
 * @param {Object} params.data the data given to the created mock server. It is
 *   used to generate mock answers for every kind of routes supported by odoo
 * @param {number} [params.logLevel] the log level. If it is 0, no logging is
 *   done, if 1, some light logging is done, if 2, detailed logs will be
 *   displayed for all rpcs.  Most of the time, when working on a test, it is
 *   frequent to set this parameter to 2
 * @param {function} [params.mockRPC] a function that will be used to override
 *   the _performRpc method from the mock server. It is really useful to add
 *   some custom rpc mocks, or to check some assertions.
 * @param {Object} [params.session] if it is given, it will be used as answer
 *   for all calls to this.getSession() by the widget, of its children.  Also,
 *   it will be used to extend the current, real session. This side effect is
 *   undone when the widget is destroyed.
 * @param {Object} [params.translateParameters] if given, it will be used to
 *   extend the core._t.database.parameters object. After the widget
 *   destruction, the original parameters will be restored.
 *
 * @returns {MockServer} the instance of the mock server, created by this
 *   function. It is necessary for createAsyncView so that method can call some
 *   other methods on it.
 */
function addMockEnvironment(widget, params) {
    var Server = MockServer;
    if (params.mockRPC) {
        Server = MockServer.extend({_performRpc: params.mockRPC});
    }
    var mockServer = new Server(params.data, {
        logLevel: params.logLevel,
        currentDate: params.currentDate,
    });
    var widgetDestroy;

    // make sure the debounce value for input fields is set to 0
    var initialDebounce = AbstractField.prototype.DEBOUNCE;
    AbstractField.prototype.DEBOUNCE = params.fieldDebounce || 0;

    if ('session' in params) {
        var initialSession = _.extend({}, session);
        _.extend(session, params.session);
        widgetDestroy = widget.destroy;
        widget.destroy = function () {
            for (var key in session) {
                delete session[key];
            }
            _.extend(session, initialSession);
            widgetDestroy.call(this);
        };
    }

    if ('config' in params) {
        var initialConfig = _.extend({}, config);
        _.extend(config, params.config);
        widgetDestroy = widget.destroy;
        widget.destroy = function () {
            for (var key in config) {
                delete config[key];
            }
            _.extend(config, initialConfig);
            AbstractField.prototype.DEBOUNCE = initialDebounce;
            widgetDestroy.call(this);
        };
    }

    if ('translateParameters' in params) {
        var initialParameters = _.extend({}, core._t.database.parameters);
        _.extend(core._t.database.parameters, params.translateParameters);
        var oldDestroy = widget.destroy;
        widget.destroy = function () {
            for (var key in core._t.database.parameters) {
                delete core._t.database.parameters[key];
            }
            _.extend(core._t.database.parameters, initialParameters);
            oldDestroy.call(this);
        };
    }


    intercept(widget, 'call_service', function (event) {
        if (event.data.service === 'ajax') {
            var result = mockServer.performRpc(event.data.args[0], event.data.args[1]);
            event.data.callback(result);
        }
    });

    intercept(widget, "load_views", function (event) {
        if (params.logLevel === 2) {
            console.log('[mock] load_views', event.data);
        }
        var views = {};
        var model = event.data.modelName;
        _.each(event.data.views, function (view_descr) {
            var view_id = view_descr[0] || false;
            var view_type = view_descr[1];
            var key = [model, view_id, view_type].join(',');
            var arch = params.archs[key];
            if (!arch) {
                throw new Error('No arch found for key ' + key);
            }
            views[view_type] = mockServer.fieldsViewGet(arch, model);
        });

        event.data.on_success(views);
    });

    intercept(widget, "get_session", function (event) {
        event.data.callback(params.session || session);
    });

    intercept(widget, "load_filters", function (event) {
        if (params.logLevel === 2) {
            console.log('[mock] load_filters', event.data);
        }
        event.data.on_success([]);
    });

    return mockServer;
}

/**
 * create a model from given parameters.
 *
 * @param {Object} params This object will be given to addMockEnvironment, so
 *   any parameters from that method applies
 * @param {Class} params.Model the model class to use
 * @param {string[]} [params.fieldNames] the fields given to the model
 * @param {Object[]} [params.fields] map of field names to field description
 * @param {Object[]} [params.fieldsInfo] map of field names to field attributes
 * @returns {Model}
 */
function createModel(params) {
    var widget = new Widget();

    var model = new params.Model(widget, {
        fieldsInfo: params.fieldsInfo,
        fieldNames: params.fieldNames,
        fields: params.fields,
    });

    addMockEnvironment(widget, params);

    return model;
}

/**
 * simulate a drag and drop operation between 2 jquery nodes: $el and $to.
 * This is a crude simulation, with only the mousedown, mousemove and mouseup
 * events, but it is enough to help test drag and drop operations with jqueryUI
 * sortable.
 *
 * @param {jqueryElement} $el
 * @param {jqueryElement} $to
 */
function dragAndDrop($el, $to) {
    var elementCenter = $el.offset();
    elementCenter.left += $el.outerWidth()/2;
    elementCenter.top += $el.outerHeight()/2;

    var toCenter = $to.offset();
    toCenter.left += $to.outerWidth()/2;
    toCenter.top += $to.outerHeight()/2;

    $el.trigger($.Event("mousedown", {
        which: 1,
        pageX: elementCenter.left,
        pageY: elementCenter.top
    }));

    $el.trigger($.Event("mousemove", {
        which: 1,
        pageX: toCenter.left,
        pageY: toCenter.top
    }));

    $el.trigger($.Event("mouseup", {
        which: 1,
        pageX: toCenter.left,
        pageY: toCenter.top
    }));
}

/**
 * simulate a mouse event with a custom event who add the item position. This is
 * sometimes necessary because the basic way to trigger an event (such as
 * $el.trigger('mousemove')); ) is too crude for some uses.
 *
 * @param {jqueryElement} $el
 * @param {string} type a mouse event type, such as 'mousedown' or 'mousemove'
 */
function triggerMouseEvent($el, type) {
    var pos = $el.offset();
    var e = new jQuery.Event(type);
    e.pageX = pos.left;
    e.pageY = pos.top;
    e.which = 1;
    $el.trigger(e);
}

/**
 * Removes the src attribute on images and iframes to prevent not found errors,
 * and optionally triggers an rpc with the src url as route on a widget.
 *
 * @param {JQueryElement} $el
 * @param {[Widget]} widget the widget on which the rpc should be performed
 */
function removeSrcAttribute($el, widget) {
    $el.find('img, iframe[src]').each(function () {
        var src = $(this).attr('src');
        if (src[0] !== '#') {
            $(this).attr('src', '#test:' + $(this).attr('src'));
            if (widget) {
                widget._rpc({route: src});
            }
        }
    });
}

return session.is_bound.then(function () {
    setTimeout(function () {
        // this is done with the hope that tests are
        // only started all together...
        QUnit.start();
    }, 0);
    return {
        intercept: intercept,
        observe: observe,
        createView: createView,
        createAsyncView: createAsyncView,
        createModel: createModel,
        addMockEnvironment: addMockEnvironment,
        dragAndDrop: dragAndDrop,
        triggerMouseEvent: triggerMouseEvent,
        removeSrcAttribute: removeSrcAttribute,
    };
});

});
