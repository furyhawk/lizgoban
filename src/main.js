/////////////////////////////////////////////////
// command line option

// example:
// npx electron src -j '{"leelaz_args": ["-g", "-w", "/foo/bar/network.gz"]}'

const option = {
    leelaz_command: __dirname + "/../external/leelaz",
    leelaz_args: ["-g", "-w", __dirname + "/../external/network.gz"],
    analyze_interval_centisec: 10,
    minimum_suggested_moves: 30,
    engine_log_line_length: 500,
    sabaki_command: __dirname + '/../external/sabaki',
    minimum_auto_restart_millisec: 5000,
    endstate_leelaz: null,
    weight_dir: undefined,
}
process.argv.forEach((x, i, a) => (x === "-j") && Object.assign(option, JSON.parse(a[i + 1])))

/////////////////////////////////////////////////
// setup

// electron
const electron = require('electron')
const {dialog, app, clipboard, Menu} = electron, ipc = electron.ipcMain

// leelaz
const {create_leelaz} = require('./engine.js')
let leelaz = leelaz_for_black = create_leelaz(), leelaz_for_white = null
let leelaz_for_endstate = null

// util
require('./util.js').use(); require('./coord.js').use()
function safely(proc, ...args) {try {return proc(...args)} catch(e) {return null}}
const SGF = require('@sabaki/sgf')
const PATH = require('path'), fs = require('fs'), TMP = require('tmp')
const store = new (safely(require, 'electron-store') ||
                   // try old name for backward compatibility
                   safely(require, 'electron-config') ||
                   // ... and throw the original error when both fail
                   require('electron-store'))({name: 'lizgoban'})

// debug log
const debug_log_key = 'debug_log'
function update_debug_log() {debug_log(!!store.get(debug_log_key))}
function toggle_debug_log() {debug_log(!!toggle_stored(debug_log_key))}
update_debug_log()
debug_log("option: " + JSON.stringify(option))

// state
let next_history_id = 0
let history = create_history()
let sequence = [history], sequence_cursor = 0, initial_b_winrate = NaN
let auto_analysis_signed_visits = Infinity, auto_play_count = 0
const simple_ui = false, winrate_trail = true
let auto_play_sec = 0, auto_replaying = false, auto_bturn = true
let pausing = false, busy = false
let endstate_diff_interval = 12

// renderer state
// (cf.) "set_renderer_state" in this file
// (cf.) "the_board_handler" and "the_suggest_handler" in engine.js
const R = {stones: aa_new(19, 19, () => ({}))}

// sabaki
let attached = false, has_sabaki = true
fs.access(option.sabaki_command, null,
          (err) => err && fs.access(option.sabaki_command + '.exe', null,
                                    (err) => err && (has_sabaki = false)))

/////////////////////////////////////////////////
// electron

let windows = [], last_window_id = -1

function window_prop(win) {  // fixme: adding private data impolitely
    const private_key = 'lizgoban_window_prop'
    return win[private_key] || (win[private_key] = {
        window_id: -1, board_type: '', previous_board_type: ''
    })
}

function window_for_id(window_id) {
    return get_windows().find(win => window_prop(win).window_id === window_id)
}

function get_windows() {
    return windows = windows.filter(win => !win.isDestroyed())
}

function get_new_window(file_name, opt) {
    const win = new electron.BrowserWindow(opt)
    win.loadURL('file://' + __dirname + '/' + file_name)
    return win
}

function new_window(default_board_type) {
    const window_id = ++last_window_id, conf_key = 'window.id' + window_id
    const ss = electron.screen.getPrimaryDisplay().size
    const {board_type, previous_board_type, position, size} = store.get(conf_key) || {}
    const [x, y] = position || [0, 0]
    const [width, height] = size || [ss.height, ss.height * 0.6]
    const webPreferences = {nodeIntegration: true}
    const win = get_new_window('index.html',
                               {x, y, width, height, webPreferences, show: false})
    const prop = window_prop(win)
    merge(prop, {
        window_id, board_type: board_type || default_board_type, previous_board_type
    })
    win.on('close', () => store.set(conf_key, {
        board_type: prop.board_type, previous_board_type: prop.previous_board_type,
        position: win.getPosition(), size: win.getSize()
    }))
    windows.push(win)
    win.once('ready-to-show', () => {update_ui(); win.show()})
}

app.on('ready', () => {
    leelaz.start(leelaz_start_args()); update_menu(); new_window('double_boards')
    if (!option.endstate_leelaz) {return}
    leelaz.activate(false)
    const [lz_command, weight] = option.endstate_leelaz
    const es_args = {...leelaz_start_args(weight), leelaz_command: lz_command}
    leelaz_for_endstate = create_leelaz()
    leelaz_for_endstate.start(es_args); leelaz_for_endstate.set_pondering(false)
})
app.on('window-all-closed', app.quit)
app.on('quit', () => each_leelaz(z => z.kill()))
function each_leelaz(f) {
    [leelaz_for_black, leelaz_for_white, leelaz_for_endstate].forEach(z => z && f(z))
}

function renderer(channel, ...args) {renderer_gen(channel, false, ...args)}
function renderer_with_window_prop(channel, ...args) {
    renderer_gen(channel, true, ...args)
}
function renderer_gen(channel, win_prop_p, ...args) {
    // Caution [2018-08-08]
    // (1) JSON.stringify(NaN) is 'null' (2) ipc converts {foo: NaN} to {}
    // example:
    // [main.js] renderer('foo', {bar: NaN, baz: null, qux: 3})
    // [renderer.js] ipc.on('foo', (e, x) => tmp = x)
    // [result] tmp is {baz: null, qux: 3}
    get_windows().forEach(win => win.webContents
                          .send(channel, ...(win_prop_p ? [window_prop(win)] : []),
                                ...args))
}

function leelaz_start_args(weight_file) {
    const restart_handler = auto_restart, leelaz_args = option.leelaz_args.slice()
    const weight_pos = leelaz_weight_option_pos_in_args()
    weight_file && weight_pos >= 0 && (leelaz_args[weight_pos + 1] = weight_file)
    const h = {leelaz_args, board_handler, suggest_handler, restart_handler}
    const opts = ['leelaz_command', 'analyze_interval_centisec',
                  'minimum_suggested_moves', 'engine_log_line_length']
    opts.forEach(key => h[key] = option[key])
    return h
}
function leelaz_weight_file(leelaz_for_black_or_white) {
    const k = leelaz_weight_option_pos_in_args()
    const arg = (leelaz_for_black_or_white || leelaz).start_args()
    return (k >= 0) && arg && arg.leelaz_args[k + 1]
}
function leelaz_weight_option_pos_in_args() {
    return option.leelaz_args.findIndex(z => z === "-w" || z === "--weights")
}

/////////////////////////////////////////////////
// from renderer

// normal commands

const simple_api = {
    unset_busy, update_menu, toggle_board_type, toggle_let_me_think,
    copy_sgf_to_clipboard,
}
const api = merge({}, simple_api, {
    restart, new_window, init_from_renderer, toggle_sabaki,
    toggle_pause,
    play, undo, redo, explicit_undo, pass, undo_ntimes, redo_ntimes, undo_to_start, redo_to_end,
    let_me_think_next,
    goto_move_count, toggle_auto_analyze, play_best, play_weak, auto_play, stop_auto,
    paste_sgf_from_clipboard, open_sgf, save_sgf,
    next_sequence, previous_sequence, nth_sequence, cut_sequence, duplicate_sequence,
    help,
    // for debug
    send_to_leelaz: leelaz.send_to_leelaz,
})

function api_handler(channel, handler, busy) {
    return (e, ...args) => {
        channel === 'toggle_auto_analyze' || stop_auto_analyze()
        channel === 'play_best' || stop_auto_play()
        set_or_unset_busy(busy)
        handler(...args)
    }
}

each_key_value(api, (channel, handler) => {
    const simple = Object.keys(simple_api).indexOf(channel) >= 0
    ipc.on(channel,
           simple ? (e, ...a) => handler(...a) : api_handler(channel, handler))
})

// special commands

function cached(f) {
    let cache = {}; return key => cache[key] || (cache[key] = f(key))
}
const busy_handler_for =
      cached(subchannel => api_handler(subchannel, api[subchannel], true))
ipc.on('busy', (e, subchannel, ...args) => busy_handler_for(subchannel)(e, ...args))

ipc.on('close_window_or_cut_sequence', e => {
           stop_auto()
           get_windows().forEach(win => (win.webContents === e.sender) &&
                                 close_window_or_cut_sequence(win))
       })

/////////////////////////////////////////////////
// action

// game play
function play(move, force_create, default_tag) {
    const [i, j] = move2idx(move), pass = (i < 0)
    if (!pass && (!R.stones[i] || !R.stones[i][j] || R.stones[i][j].stone)) {return}
    !pass && (R.stones[i][j] = {stone: true, black: R.bturn, maybe: true})
    const new_sequence_p = (history.len() > 0) && create_sequence_maybe(force_create)
    const tag = R.move_count > 0 &&
          (new_sequence_p ? new_tag() :
           history.ref(R.move_count) === history.last_loaded_element ?
           last_loaded_element_tag_letter : false)
    update_state(); do_play(move, R.bturn, tag || default_tag || undefined)
    pass && wink()
}
function do_play(move, is_black, tag) {
    // We drop "pass" except for the last of history.
    // B:D16, W:Q4, B:pass ==> ok
    // B:D16, W:Q4, B:pass, W:D4 ==> B:D16, W:Q4, W:D4
    // B:D16, W:Q4, B:pass, W:pass ==> B:D16, W:Q4
    // This is because ...
    // (1) Leelaz counts only the last passes in "showboard".
    // (2) Leelaz stops analysis after double pass.
    const last_pass = is_last_move_pass(), double_pass = last_pass && is_pass(move)
    last_pass && history.pop()
    !double_pass && history.push({move, is_black, tag, move_count: history.len() + 1})
    set_board(history)
}
function undo() {undo_ntimes(1)}
function redo() {redo_ntimes(1)}
function explicit_undo() {
    const delete_last = () => (history.pop(), set_board(history))
    R.move_count < history.len() ? undo() : wink_if_pass(delete_last)
}
const pass_command = 'pass'
function pass() {play(pass_command)}
function is_pass(move) {return move === pass_command}
function is_last_move_pass() {return is_pass(history.last_move())}

// multi-undo/redo
function undo_ntimes(n) {wink_if_pass(goto_move_count, R.move_count - n)}
function redo_ntimes(n) {undo_ntimes(- n)}
function undo_to_start() {undo_ntimes(Infinity)}
function redo_to_end() {redo_ntimes(Infinity)}

// util
function set_board(history, move_count) {
    set_board_sub(truep(move_count) ? history.hist.slice(0, move_count) : history.hist)
}
function reset_board() {set_board_sub([])}
function set_board_sub(hist) {
    each_leelaz(z => z.set_board(hist)); R.move_count = hist.length
    R.bturn = !(hist[hist.length - 1] || {}).is_black
    R.visits = null
    switch_leelaz()
    board_state_is_changed()
}
function board_state_is_changed() {update_let_me_think()}

function goto_move_count(count) {
    const c = clip(count, 0, history.len())
    if (c === R.move_count) {return}
    update_state_to_move_count_tentatively(c)
    set_board(history, c)
}
function update_state_to_move_count_tentatively(count) {
    const forward = (count > R.move_count)
    const [from, to] = forward ? [R.move_count, count] : [count, R.move_count]
    const set_stone_at = (move, stone_array, stone) => {
        aa_set(stone_array, ...move2idx(move), stone)
    }
    history.hist.slice(from, to).forEach(m => set_stone_at(m.move, R.stones, {
        stone: true, maybe: forward, maybe_empty: !forward, black: m.is_black
    }))
    const next_h = history.ref(R.move_count + 1)
    const next_s = stone_for_history_elem(next_h, R.stones) || {}
    next_s.next_move = false; R.move_count = count; R.bturn = (count % 2 === 0)
    update_state()
}
function undoable() {return R.move_count > 0}
function redoable() {return history.len() > R.move_count}
function restart() {restart_with_args()}
function restart_with_args(h) {
    leelaz.restart(h); switch_to_nth_sequence(sequence_cursor); stop_auto()
}
function pause() {pausing = true; update_ponder_and_ui()}
function resume() {pausing = false; update_ponder_and_ui()}
function toggle_pause() {pausing = !pausing; update_ponder_and_ui()}
function set_or_unset_busy(bool) {busy = bool; update_ponder()}
function set_busy() {set_or_unset_busy(true)}
function unset_busy() {set_or_unset_busy(false)}
function update_ponder() {
    const pondering = !pausing && !busy, b = (leelaz === leelaz_for_black)
    leelaz_for_black.set_pondering(pondering && b)
    leelaz_for_white && leelaz_for_white.set_pondering(pondering && !b)
}
function update_ponder_and_ui() {update_ponder(); update_ui()}
function init_from_renderer() {leelaz.update()}

function wink_if_pass(proc, ...args) {
    const rec = () => history.ref(R.move_count)
    const before = rec()
    proc(...args)
    const after = rec(), d = after.move_count - before.move_count
    if (Math.abs(d) !== 1) {return}
    const implicit_pass = !!before.is_black === !!after.is_black
    const pass = implicit_pass || is_pass((d === 1 ? after : before).move)
    pass && wink()
}
function wink() {renderer('wink')}

// tag letter
let next_tag_count = 0
const normal_tag_letters = 'bcdefghijklmnorstuvwy'
const last_loaded_element_tag_letter = '.'
const start_moves_tag_letter = "'"
const endstate_diff_tag_letter = "/"
const tag_letters = normal_tag_letters + last_loaded_element_tag_letter +
      start_moves_tag_letter + endstate_diff_tag_letter
function new_tag() {
    const used = history.map(h => h.tag || '').join('')
    const first_unused_index = normal_tag_letters.repeat(2).slice(next_tag_count)
          .split('').findIndex(c => used.indexOf(c) < 0)
    const tag_count = (next_tag_count + Math.max(first_unused_index, 0))
          % normal_tag_letters.length
    next_tag_count = tag_count + 1
    return normal_tag_letters[tag_count]
}

// play best move(s)
function play_best(n, weaken_method, ...weaken_args) {
    auto_play(null, true); increment_auto_play_count(n)
    try_play_best(weaken_method, ...weaken_args)
}
function play_weak(percent) {
    play_best(null, leelaz_for_white ? 'random_leelaz' : 'random_candidate', percent)
}
function try_play_best(weaken_method, ...weaken_args) {
    // (ex)
    // try_play_best()
    // try_play_best('pass_maybe')
    // try_play_best('random_candidate', 30)
    // try_play_best('random_leelaz', 30)
    const switch_to_random_leelaz = percent => {
        switch_leelaz(xor(R.bturn, Math.random() < percent / 100))
    }
    weaken_method === 'random_leelaz' && switch_to_random_leelaz(...weaken_args)
    if (empty(R.suggest)) {return}
    const move = (weaken_method === 'random_candidate' ?
                  weak_move(...weaken_args) : best_move())
    const pass_maybe =
          () => leelaz.peek_value('pass', value => play(value < 0.9 ? 'pass' : move))
    const play_it = () => {
        decrement_auto_play_count()
        weaken_method === 'pass_maybe' ? pass_maybe() : play(move)
    }
    do_as_auto_play(move !== 'pass', play_it)
}
function best_move() {return R.suggest[0].move}
function weak_move(weaken_percent) {
    // (1) Converge winrate to 0 with move counts
    // (2) Occasionally play good moves with low probability
    // (3) Do not play too bad moves
    const r = clip((weaken_percent || 0) / 100, 0, 1)
    const initial_target_winrate = 40 * 10**(- r)
    const target = initial_target_winrate * 2**(- R.move_count / 100)  // (1)
    const flip_maybe = x => R.bturn ? x : 100 - x
    const current_winrate = flip_maybe(winrate_after(R.move_count))
    const u = Math.random()**(1 - r) * r  // (2)
    const next_target = current_winrate * (1 - u) + target * u  // (3)
    return nearest_move_to_winrate(next_target)
}
function nearest_move_to_winrate(target_winrate) {
    const min_by = (f, a) => {
        const b = a.map(f), m = Math.min(...b); return a[b.indexOf(m)]
    }
    const not_too_bad = R.suggest.filter(s => s.winrate >= target_winrate)
    const selected = min_by(s => Math.abs(s.winrate - target_winrate),
                  empty(not_too_bad) ? R.suggest : not_too_bad)
    debug_log(`weak_move: target_winrate=${target_winrate} ` +
              `move=${selected.move} winrate=${selected.winrate} ` +
              `visits=${selected.visits} order=${selected.order} ` +
              `winrate_order=${selected.winrate_order}`)
    return selected.move
}

// board type
function toggle_board_type(window_id, type) {
    if (let_me_think_p() && !type) {toggle_board_type_in_let_me_think(); return}
    const win = window_for_id(window_id)
    const {board_type, previous_board_type} = window_prop(win)
    const new_type = (type && board_type !== type) ? type : previous_board_type
    set_board_type(new_type, win, !type)
}
function set_board_type(type, win, keep_let_me_think) {
    const prop = window_prop(win), {board_type, previous_board_type} = prop
    if (!type || type === board_type) {return}
    keep_let_me_think || stop_let_me_think()
    merge(prop, {board_type: type, previous_board_type: board_type}); update_ui()
}

// auto-restart
let last_restart_time = 0
function auto_restart() {
    const buttons = ["retry", "load weight file", "save SGF and quit", "quit"]
    const actions = [restart, load_weight, () => (save_sgf(), app.quit()), app.quit];
    (Date.now() - last_restart_time >= option.minimum_auto_restart_millisec) ?
        (restart(), last_restart_time = Date.now()) :
        dialog.showMessageBox(null, {
            type: "error", message: "Leela Zero is down.", buttons: buttons,
        }, response => actions[response]())
}

// handicap stones
function add_handicap_stones(k) {
    // [2019-04-29] ref.
    // https://www.nihonkiin.or.jp/teach/lesson/school/start.html
    // https://www.nihonkiin.or.jp/teach/lesson/school/images/okigo09.gif
    const exceptions = [5, 7], first = 'Q16', center = 'K10'
    const pos = [first, 'D4', 'Q4', 'D16', 'Q10', 'D10', 'K16', 'K4', center]
    const moves = pos.slice(0, k)
    exceptions.includes(k) && (moves[k - 1] = center)
    moves.forEach(m => do_play(m, true))
}
function ask_handicap_stones() {
    const ks = seq(8, 2), buttons = [...ks.map(to_s), 'cancel']
    const action = response => {
        const k = ks[response]; if (!k) {return}
        history.is_empty() || new_empty_board(); add_handicap_stones(k)
    }
    dialog.showMessageBox(null, {
        type: "question", message: "Handicap stones", buttons: buttons,
    }, action)
}

// load weight file for leelaz
let previous_weight_file = null
function load_weight() {
    return load_weight_file(select_files('Select weight file for leela zero')[0])
}
function load_weight_file(weight_file) {
    const current_weight_file = leelaz_weight_file()
    if (!weight_file) {return false}
    weight_file !== current_weight_file &&
        (previous_weight_file = current_weight_file)
    restart_with_args(leelaz_start_args(weight_file))
    return weight_file
}
function select_files(title) {
    return files = dialog.showOpenDialog(null, {
        properties: ['openFile'], title: title,
        defaultPath: option.weight_dir,
    }) || []
}
function switch_to_previous_weight() {load_weight_file(previous_weight_file)}

// misc.
function toggle_trial() {history.trial = !history.trial; update_state()}
function endstate_diff_interval_adder(k) {
    return () => {
        endstate_diff_interval = clip(endstate_diff_interval + k, 2)
        leelaz_for_endstate.update()
    }
}
function close_window_or_cut_sequence(win) {
    get_windows().length > 1 ? win.close() :
        attached ? null :
        (sequence.length <= 1 && history.is_empty()) ? win.close() : cut_sequence()
}
function help() {
    const menu = [
        {label: 'File', submenu: [{role: 'close'}]},
        {label: 'View',
         submenu: [{role: 'zoomIn'}, {role: 'zoomOut'}, {role: 'resetZoom'}]}
    ]
    get_new_window('help.html').setMenu(Menu.buildFromTemplate(menu))
}
function info() {
    const f = (label, s) => s ?
          `<${label}>\n` + fold_text(JSON.stringify(s), 80, 5) + '\n\n' : ''
    const lz = leelaz_for_white ?
          (f("leelaz (black)", leelaz_for_black.start_args()) +
           f("leelaz (white)", leelaz_for_white.start_args())) :
          f("leelaz", leelaz.start_args())
    const message = lz +
          f("sgf file", history.sgf_file) +
          f("sgf", history.sgf_str)
    dialog.showMessageBox({type: "info",  buttons: ["OK"], message})
}
function fold_text(str, n, max_lines) {
    const fold_line =
          s => s.split('').map((c, i) => i % n === n - 1 ? c + '\n' : c).join('')
    const cut = s => s.split('\n').slice(0, max_lines).join('\n')
    return cut(str.split('\n').map(fold_line).join('\n'))
}

/////////////////////////////////////////////////
// auto-analyze / auto-play

// common
function try_auto() {auto_playing() ? try_auto_play() : try_auto_analyze()}
function auto_progress() {
    return Math.max(auto_analysis_progress(), auto_play_progress())
}
function stop_auto() {stop_auto_analyze(); stop_auto_play(); update_ui()}

// auto-analyze (redo after given visits)
function try_auto_analyze() {
    const done = R.max_visits >= auto_analysis_visits()
    const next = (pred, proc) => pred() ?
          proc() : (pause(), stop_auto_analyze(), update_ui())
    auto_bturn = xor(R.bturn, done)
    done && next(...(backward_auto_analysis_p() ? [undoable, undo] : [redoable, redo]))
}
function toggle_auto_analyze(visits) {
    if (history.is_empty()) {return}
    (auto_analysis_signed_visits === visits) ?
        (stop_auto_analyze(), update_ui()) :
        start_auto_analyze(visits)
}
function start_auto_analyze(visits) {
    auto_analysis_signed_visits = visits; rewind_maybe(); resume(); update_ui()
}
function stop_auto_analyze() {auto_analysis_signed_visits = Infinity}
function auto_analyzing() {return auto_analysis_signed_visits < Infinity}
function auto_analysis_progress() {
    return auto_analyzing() ? R.max_visits / auto_analysis_visits() : -1
}
function auto_analysis_visits() {return Math.abs(auto_analysis_signed_visits)}
function backward_auto_analysis_p() {return auto_analysis_signed_visits < 0}
function rewind_maybe() {
    backward_auto_analysis_p() ?
        (undoable() || redo_to_end()) : (redoable() || undo_to_start())
}
stop_auto_analyze()

// auto-play (auto-replay (redo) or self-play (play_best) in every XX seconds)
let last_auto_play_time = 0
function auto_play(sec, explicitly_playing_best) {
    explicitly_playing_best ? (auto_replaying = false) : (auto_play_count = Infinity)
    auto_replaying && rewind_maybe()
    auto_play_sec = sec || -1; stop_auto_analyze()
    update_auto_play_time(); update_let_me_think(); resume(); update_ui()
}
function try_auto_play() {
    auto_play_ready() && (auto_replaying ? try_auto_replay() : try_play_best())
    update_let_me_think(true)
}
function try_auto_replay() {do_as_auto_play(redoable(), redo)}
function auto_play_ready() {
    return !empty(R.suggest) && Date.now() - last_auto_play_time >= auto_play_sec * 1000
}
function do_as_auto_play(playable, proc) {
    playable ? (proc(), update_auto_play_time()) : (stop_auto_play(), pause())
}
function update_auto_play_time() {last_auto_play_time = Date.now(); auto_bturn = R.bturn}
function auto_play_progress() {
    return auto_playing(true) ?
        (Date.now() - last_auto_play_time) / (auto_play_sec * 1000) : -1
}
function ask_auto_play_sec(win, replaying) {
    auto_replaying = replaying; win.webContents.send('ask_auto_play_sec')
}
function increment_auto_play_count(n) {
    auto_playing(true) && stop_auto_play()
    auto_play_count += (n || 1)  // It is Infinity after all if n === Infinity
}
function decrement_auto_play_count() {auto_play_count--}
function stop_auto_play() {
    auto_playing() && ((auto_play_count = 0), let_me_think_exit_autoplay())
}
function auto_playing(forever) {
    return auto_play_count >= (forever ? Infinity : 1)
}

/////////////////////////////////////////////////
// let-me-think-first mode

// fixme: this mode uses the first window even if it is requested from other windows
function let_me_think_window() {return get_windows()[0]}

const let_me_think_board_type =
      {first_half: 'double_boards_swap', latter_half: 'double_boards'}
let let_me_think_previous_stage = null

function update_let_me_think(only_when_stage_is_changed) {
    if (!let_me_think_p()) {let_me_think_previous_stage = null; return}
    let_me_think_switch_board_type(only_when_stage_is_changed)
}
function let_me_think_switch_board_type(only_when_stage_is_changed) {
    const progress = auto_play_progress(); if (progress < 0) {return}
    const stage = progress < 0.5 ? 'first_half' : 'latter_half'
    if (only_when_stage_is_changed && stage === let_me_think_previous_stage) {return}
    let_me_think_set_board_type_for(stage)
}
function let_me_think_set_board_type_for(stage) {
    set_board_type(let_me_think_board_type[let_me_think_previous_stage = stage],
                   let_me_think_window(), true)
}

function toggle_board_type_in_let_me_think() {
    const win = let_me_think_window()
    const current_type = window_prop(win).board_type
    const all_types = Object.values(let_me_think_board_type)
    const other_type = all_types.find(type => type != current_type)
    set_board_type(other_type, win, true)
}
function let_me_think_exit_autoplay() {let_me_think_set_board_type_for('latter_half')}

function toggle_let_me_think() {set_let_me_think(!let_me_think_p())}
function stop_let_me_think() {set_let_me_think(false)}
function set_let_me_think(val) {
    store.set('let_me_think', val); update_let_me_think(); update_state()
}
function let_me_think_p() {return store.get('let_me_think')}

function let_me_think_next(board_type) {
    const stay = (board_type === let_me_think_board_type.first_half || !redoable())
    stay || redo()
    let_me_think_set_board_type_for(stay ? 'latter_half' : 'first_half')
}

/////////////////////////////////////////////////
// from leelaz to renderer

function set_renderer_state(...args) {
    const winrate_history = winrate_from_history(history)
    const previous_suggest = get_previous_suggest()
    const progress_bturn = auto_bturn
    const weight_info = weight_info_text()
    const network_size = leelaz.network_size()
    const endstate_sum = leelaz_for_endstate && average_endstate_sum()
    const endstate_d_i = leelaz_for_endstate ? {endstate_diff_interval} : {}
    const stored_keys = ['lizzie_style', 'expand_winrate_bar', 'let_me_think',
                         'show_endstate']
    stored_keys.forEach(key => R[key] = store.get(key, false))
    merge(R, {winrate_history, endstate_sum,
              progress_bturn,
              weight_info, network_size, tag_letters, start_moves_tag_letter,
              endstate_diff_tag_letter,
              previous_suggest, winrate_trail}, endstate_d_i, ...args)
    // clean me: R.max_visits is needed for auto_progress()
    R.max_visits = clip(Math.max(...(R.suggest || []).map(h => h.visits)), 1)
    R.progress = auto_progress()
}
function set_and_render(...args) {
    set_renderer_state(...args)
    const masked_R = merge({}, R, show_suggest_p() ? {} : {suggest: [], visits: null})
    renderer('render', masked_R)
}

function average_endstate_sum(move_count) {
    const mc = truep(move_count) || R.move_count
    const [cur, prev] = [0, 1].map(k => history.ref(mc - k).endstate_sum)
    return truep(cur) && truep(prev) && (cur + prev) / 2
}

function get_previous_suggest() {
    const [cur, prev] = [0, 1].map(k => history.ref(R.move_count - k))
    // avoid "undefined" and use "null" for merge in set_renderer_state
    const ret = (prev.suggest || []).find(h => h.move === (cur.move || '')) || null
    ret && (ret.bturn = !prev.is_black)
    return ret
}

function weight_info_text() {
    const f = lz =>
          `${PATH.basename(leelaz_weight_file(lz)) || ''} ${lz.network_size() || ''}`
    return leelaz_for_white ?
        `${f(leelaz_for_black)} / ${f(leelaz_for_white)}` : f(leelaz)
}

// board
function board_handler(h) {
    const sum = ary => flatten(ary).reduce((a, c) => a + c, 0)
    const board_setter = () => {
        add_next_mark_to_stones(R.stones, history, R.move_count)
        add_info_to_stones(R.stones, history)
    }
    const endstate_setter = update_p => {
        const prev = R.move_count - endstate_diff_interval
        const prev_endstate = update_p && history.ref(prev).endstate
        const add_endstate_to_history = z => {
            z.endstate = R.endstate; update_p && (z.endstate_sum = sum(R.endstate))
        }
        add_endstate_to_stones(R.stones, R.endstate, prev_endstate)
        R.move_count > 0 && add_endstate_to_history(history.ref(R.move_count))
    }
    set_renderer_state(h)
    h.endstate || board_setter(); leelaz_for_endstate && endstate_setter(!!h.endstate)
    update_state()
}

function update_state() {
    set_renderer_state()  // need to update R.show_endstate
    const history_length = history.len(), sequence_length = sequence.length, suggest = []
    const sequence_ids = sequence.map(h => h.id)
    const pick_tagged = h => {
        const h_copy = append_endstate_tag_maybe(h)
        return h_copy.tag ? [h_copy] : []
    }
    const history_tags = flatten(history.map(pick_tagged))
    const {player_black, player_white, trial} = history
    set_and_render({
        history_length, suggest, sequence_cursor, sequence_length, attached,
        player_black, player_white, trial, sequence_ids, history_tags
    })
    update_ui(true)
}

function append_endstate_tag_maybe(h) {
    const h_copy = merge({}, h)
    leelaz_for_endstate && R.show_endstate &&
        h.move_count === R.move_count - endstate_diff_interval &&
        add_tag(h_copy, endstate_diff_tag_letter)
    return h_copy
}

function add_tag(h, tag) {h.tag = str_uniq((h.tag || '') + (tag || ''))}

function update_ui(ui_only) {
    update_menu(); renderer_with_window_prop('update_ui', availability(), ui_only)
}

function add_next_mark_to_stones(stones, history, move_count) {
    const h = history.ref(move_count + 1), s = stone_for_history_elem(h, stones)
    s && (s.next_move = true) && (s.next_is_black = h.is_black)
}

function add_info_to_stones(stones, history) {
    history.forEach((h, c) => {
        const s = stone_for_history_elem(h, stones); if (!s) {return}
        add_tag(s, h.tag)
        s.stone && (h.move_count <= R.move_count) && (s.move_count = h.move_count)
        leelaz_for_endstate && truep(s.move_count) &&
            (R.move_count - endstate_diff_interval < s.move_count) && (s.recent = true)
        !s.anytime_stones && (s.anytime_stones = [])
        s.anytime_stones.push(pick_properties(h, ['move_count', 'is_black']))
    })
}

function add_endstate_to_stones(stones, endstate, prev_endstate) {
    if (!endstate) {return}
    stones.forEach((row, i) => row.forEach((s, j) => {
        s.endstate = endstate[i][j]
        prev_endstate && (s.endstate_diff = s.endstate - prev_endstate[i][j])
    }))
}

function stone_for_history_elem(h, stones) {
    return h && h.move && aa_ref(stones, ...move2idx(h.move))
}

// suggest
const too_small_prior = 1e-3
function suggest_handler(h) {
    const considerable = z => z.visits > 0 || z.prior >= too_small_prior
    h.suggest = h.suggest.filter(considerable)
    const cur = history.ref(R.move_count)
    R.move_count > 0 && (cur.suggest = h.suggest)
    R.move_count > 0 ? (cur.b_winrate = h.b_winrate) : (initial_b_winrate = h.b_winrate)
    set_and_render(h); try_auto()
}

function pick_properties(orig, keys) {
    const ret = {}; keys.forEach(k => ret[k] = orig[k]); return ret
}

function show_suggest_p() {return auto_playing() || auto_analysis_visits() >= 10}

/////////////////////////////////////////////////
// history

// example of history.hist:
// [{move: "D16", is_black: true, move_count: 1, ...},
//  {move: "Q4", is_black: false, move_count: 2, ...},
//  {move: "Q16", is_black: false, move_count: 3, ...},
//  {move: "pass", is_black: true, move_count: 4, ...}]
// 
// Black played pass for the third move and the last move in this example.

// note:
// * move_count = 1 for the first stone, that is history[0].
// * See board_handler() and suggest_handler() for "...".
// * See also do_play() for passes.

function new_history_id() {return next_history_id++}

function create_history(init_hist, init_prop) {
    const self = {}, hist = init_hist || []  // private in future
    const prop = init_prop || {  // public
        move_count: 0, player_black: "", player_white: "",
        sgf_file: "", sgf_str: "", id: new_history_id(),
        trial: false, last_loaded_element: null
    }
    const methods = {
        // mc = move_count (0: empty board, 1: first move, ...)
        len: () => hist.length,
        is_empty: () => empty(hist),
        ref: mc => hist[mc - 1] || {},
        last_move: () => (last(hist) || {}).move,
        set_last_loaded_element: () => self.last_loaded_element = last(hist),
        shallow_copy: () => create_history(hist.slice(), merge({}, prop, {
            id: new_history_id(), last_loaded_element: null
        })),
    }
    const array_methods =
          aa2hash(['push', 'pop', 'map', 'forEach']
                  .map(meth => [meth, (...args) => hist[meth](...args)]))
    return merge(self, {hist}, prop, methods, array_methods)
}

/////////////////////////////////////////////////
// sequence (list of histories)

function new_empty_board() {insert_sequence(create_history(), true)}

function backup_history() {
    if (history.is_empty()) {return}
    store_move_count(history)
    insert_sequence(history.shallow_copy())
}

function create_sequence_maybe(force) {
    const new_game = (R.move_count === 0)
    return (force || R.move_count < history.len()) &&
        (backup_history(), history.hist.splice(R.move_count),
         merge(history, {trial: !simple_ui && !new_game}))
}

function next_sequence() {previous_or_next_sequence(1, next_sequence_effect)}
function previous_sequence() {previous_or_next_sequence(-1, previous_sequence_effect)}
function previous_or_next_sequence(delta, effect) {
    sequence.length > 1 && (switch_to_nth_sequence(sequence_cursor + delta), effect())
}
function nth_sequence(n) {
    const old = sequence_cursor
    if (n === old) {return}
    switch_to_nth_sequence(n)
    n < old ? previous_sequence_effect() : next_sequence_effect()
}

let cut_first_p = false
function cut_sequence() {
    cut_first_p = (sequence_cursor === 0)
    push_deleted_sequence(history); delete_sequence()
}
function uncut_sequence() {
    insert_before = (cut_first_p && sequence_cursor === 0)
    exist_deleted_sequence() &&
        insert_sequence(pop_deleted_sequence(), true, insert_before)
}

function duplicate_sequence() {
    history.is_empty() ? new_empty_board() :
        (backup_history(), history.set_last_loaded_element(), (history.trial = true),
         update_state())
}

function delete_sequence() {
    store_move_count(history)
    sequence.length === 1 && (sequence[1] = create_history())
    sequence.splice(sequence_cursor, 1)
    const nextp = (sequence_cursor === 0)
    switch_to_nth_sequence(Math.max(sequence_cursor - 1, 0))
    nextp ? next_sequence_effect() : previous_sequence_effect()
}

function insert_sequence(new_history, switch_to, before) {
    if (!new_history) {return}
    const f = switch_to ? switch_to_nth_sequence : goto_nth_sequence
    const n = sequence_cursor + (before ? 0 : 1)
    sequence.splice(n, 0, new_history); f(n); next_sequence_effect()
}

function switch_to_nth_sequence(n) {
    const len = sequence.length, wrapped_n = (n + len) % len
    store_move_count(history); reset_board(); goto_nth_sequence(wrapped_n)
    R.move_count = 0; redo_ntimes(history.move_count); update_state()
}

function store_move_count(history) {history.move_count = R.move_count}
function goto_nth_sequence(n) {history = sequence[sequence_cursor = n]}
function next_sequence_effect() {renderer('slide_in', 'next')}
function previous_sequence_effect() {renderer('slide_in', 'previous')}

const deleted_sequences = []
const max_deleted_sequences = 100
function push_deleted_sequence(sequence) {
    deleted_sequences.push(sequence)
    deleted_sequences.splice(max_deleted_sequences)
}
function pop_deleted_sequence() {return deleted_sequences.pop()}
function exist_deleted_sequence() {return !empty(deleted_sequences)}

/////////////////////////////////////////////////
// winrate history

function winrate_before(move_count) {return winrate_after(move_count - 1)}

function winrate_after(move_count) {
    const or_NaN = x => truep(x) ? x : NaN
    return move_count < 0 ? NaN :
        move_count === 0 ? initial_b_winrate :
        or_NaN(history.ref(move_count).b_winrate)
}

function winrate_from_history(history) {
    const winrates = history.map(m => m.b_winrate)
    return [initial_b_winrate, ...winrates].map((r, s, a) => {
        const cur = history.ref(s)
        const h = append_endstate_tag_maybe(cur), tag = h.tag
        if (!truep(r)) {return {tag}}
        const move_b_eval = a[s - 1] && (r - a[s - 1])
        const move_eval = move_b_eval && move_b_eval * (cur.is_black ? 1 : -1)
        const predict = winrate_suggested(s)
        const pass = (!!h.is_black === !!history.ref(s - 1).is_black)
        const score_without_komi = average_endstate_sum(s)
        // drop "pass" to save data size for IPC
        return merge({r, move_b_eval, move_eval, tag, score_without_komi},
                     pass ? {pass} : {predict})
    })
}

function winrate_suggested(move_count) {
    const {move, is_black} = history.ref(move_count)
    const {suggest} = history.ref(move_count - 1)
    const sw = ((suggest || []).find(h => h.move === move && h.visits > 0) || {}).winrate
    return truep(sw) && (is_black ? sw : 100 - sw)
}

/////////////////////////////////////////////////
// availability

function availability() {
    return {
        undo: R.move_count > 0,
        redo: redoable(),
        attach: !attached,
        detach: attached,
        pause: !pausing,
        resume: pausing,
        bturn: R.bturn,
        wturn: !R.bturn,
        auto_analyze: !history.is_empty(),
        start_auto_analyze: !auto_analyzing() && !auto_playing(),
        stop_auto: auto_progress() >= 0,
        simple_ui: simple_ui, normal_ui: !simple_ui,
        trial: history.trial,
    }
}

/////////////////////////////////////////////////
// SGF

function copy_sgf_to_clipboard() {clipboard.writeText(history_to_sgf(history)); wink()}
function paste_sgf_from_clipboard() {read_sgf(clipboard.readText())}

function open_sgf() {select_files('Select SGF file').forEach(load_sgf)}
function load_sgf(filename) {
    read_sgf(fs.readFileSync(filename, {encoding: 'binary'}));
    history.sgf_file = filename
}

function save_sgf() {
    const f = dialog.showSaveDialog(null, {
        title: 'Save SGF file',
        // defaultPath: '.',
    })
    f && fs.writeFile(f, history_to_sgf(history), err => {if (err) throw err})
}

function history_to_sgf(hist) {
    const f = (t, p) => `${t}[${SGF.escapeString(p || '')}]`
    return `(;KM[7.5]${f('PW', history.player_white)}${f('PB', history.player_black)}` +
        hist.map(({move: move, is_black: is_black}) =>
                 (is_black ? ';B[' : ';W[') + move2sgfpos(move) + ']').join('') +
        ')'
}

function read_sgf(sgf_str) {
    try {
        const clipped = clip_sgf(sgf_str)
        load_sabaki_gametree_on_new_history(parse_sgf(clipped)[0])
        history.sgf_str = clipped
    }
    catch (e) {dialog.showErrorBox("Failed to read SGF", 'SGF text: "' + sgf_str + '"')}
}

function parse_sgf(sgf_str) {
    return convert_to_sabaki_sgf_v131_maybe(SGF.parse(sgf_str))
}

// pick "(; ... ... ])...)"
function clip_sgf(sgf_str) {return sgf_str.match(/\(\s*;[^]*\][\s\)]*\)/)[0]}

/////////////////////////////////////////////////
// Sabaki gameTree

function load_sabaki_gametree_on_new_history(gametree) {
    backup_history(); load_sabaki_gametree(gametree)
}

function load_sabaki_gametree(gametree, index) {
    if (!gametree || !gametree.nodes) {return}
    const parent_nodes = nodes_from_sabaki_gametree(gametree.parent)
    const new_history = history_from_sabaki_nodes(parent_nodes.concat(gametree.nodes))
    const com = leelaz.common_header_length(history.hist, new_history)
    // keep old history for keeping winrate
    history.hist.splice(com, Infinity, ...new_history.slice(com))
    history.set_last_loaded_element()
    const idx = (!index && index !== 0) ? Infinity : index
    const nodes_until_index = parent_nodes.concat(gametree.nodes.slice(0, idx + 1))
    const history_until_index = history_from_sabaki_nodes(nodes_until_index)
    const player_name = bw => (nodes_until_index[0][bw] || [""])[0]
    merge(history, {player_black: player_name("PB"), player_white: player_name("PW"),
                    trial: false})
    set_board(history, history_until_index.length)
    // force update of board color when C-c and C-v are typed successively
    update_state()
}

function history_from_sabaki_nodes(nodes) {
    const new_history = []; let move_count = 0
    const f = (positions, is_black) => {
        (positions || []).forEach(pos => {
            const move = sgfpos2move(pos)
            move && ++move_count && new_history.push({move, is_black, move_count})
        })
    }
    nodes.forEach(h => {f(h.AB, true); f(h.B, true); f(h.W, false)})
    return new_history
}

function nodes_from_sabaki_gametree(gametree) {
    return (gametree === null) ? [] :
        nodes_from_sabaki_gametree(gametree.parent).concat(gametree.nodes)
}

function convert_to_sabaki_sgf_v131_maybe(parsed) {
    // convert v3.0.0-style to v1.3.1-style for the result of parse() of @sabaki/sgf
    // (ref.) incompatible change in @sabaki/sgf v3.0.0
    // https://github.com/SabakiHQ/sgf/commit/a57dfe36634190ca995755bd83f677375d543b80
    const first = parsed[0]; if (!first) {return null}
    const is_v131 = first.nodes; if (is_v131) {return parsed}
    let nodes = []
    const recur = n => n && (nodes.push(n.data), recur(n.children[0]))
    recur(first)
    const parent = null, minimum_v131_gametree = {nodes, parent}
    return [minimum_v131_gametree]
}

/////////////////////////////////////////////////
// Sabaki

let sabaki_process

function start_sabaki(...sabaki_args) {
    const sabaki_command = option.sabaki_command
    debug_log('start sabaki: ' + JSON.stringify([sabaki_command, sabaki_args]))
    sabaki_process = require('child_process').spawn(sabaki_command, sabaki_args, {detached: true})
    sabaki_process.stdout.on('data', leelaz.each_line(sabaki_reader))
    leelaz.set_error_handler(sabaki_process, detach_from_sabaki)
}

function stop_sabaki() {
    // avoid "Error: kill ESRCH" when sabaki_process is down
    safely(() => {
        sabaki_process && (process.platform === 'win32' ? sabaki_process.kill() :
                           // ref. https://azimi.me/2014/12/31/kill-child_process-node-js.html
                           process.kill(- sabaki_process.pid))
    })
}

function sabaki_reader(line) {
    debug_log(`sabaki> ${line}`)
    const m = line.match(/^sabaki_dump_state:\s*(.*)/)
    m && load_sabaki_gametree(...(JSON.parse(m[1]).treePosition || []))
}

function attach_to_sabaki() {
    if (attached || !has_sabaki) {return}
    const sgf_file = TMP.fileSync({mode: 0644, prefix: 'lizgoban-', postfix: '.sgf'})
    const sgf_text = history_to_sgf(history)
    fs.writeSync(sgf_file.fd, sgf_text)
    debug_log(`temporary file (${sgf_file.name}) for sabaki: ${sgf_text}`)
    backup_history()
    start_sabaki(sgf_file.name + '#' + R.move_count)
    attached = true; leelaz.update(); update_state()
}

function detach_from_sabaki() {
    if (!attached || !has_sabaki) {return}
    stop_sabaki(); attached = false; leelaz.update(); update_state()
}

function toggle_sabaki() {
    stop_auto(); attached ? detach_from_sabaki() : attach_to_sabaki()
}

/////////////////////////////////////////////////
// another leelaz for white

function load_leelaz_for_black() {
    with_temporary_leelaz(leelaz_for_black, load_weight)
}

function load_leelaz_for_white() {
    const proc = () => {
        leelaz_for_white.activate(false)
        load_weight() || (leelaz_for_white.kill(), (leelaz_for_white = null))
    }
    with_temporary_leelaz(leelaz_for_white = create_leelaz(), proc)
}

function with_temporary_leelaz(leelaz_for_black_or_white, proc) {
    leelaz = leelaz_for_black_or_white; proc()
    leelaz = leelaz_for_black; switch_leelaz()
}

function unload_leelaz_for_white() {
    switch_to_another_leelaz(leelaz_for_black)
    leelaz_for_white && leelaz_for_white.kill(); leelaz_for_white = null
    update_state()
}

function switch_leelaz(bturn) {
    switch_to_another_leelaz((bturn === undefined ? R.bturn : bturn) ?
                             leelaz_for_black : leelaz_for_white)
}

function switch_to_another_leelaz(next_leelaz) {
    next_leelaz && next_leelaz !== leelaz &&
        (leelaz = next_leelaz) && (update_ponder(), update_state())
}

function swap_leelaz_for_black_and_white() {
    if (!leelaz_for_white) {return}
    const old_black = leelaz_for_black
    leelaz_for_black = leelaz_for_white; leelaz_for_white = old_black
    leelaz_for_black.activate(!leelaz_for_endstate); leelaz_for_white.activate(false)
    switch_leelaz()
}

/////////////////////////////////////////////////
// menu

function update_menu() {
    get_windows()
        .forEach(win => win.setMenu(simple_ui ? null :
                                    Menu.buildFromTemplate(menu_template(win))))
}

function menu_template(win) {
    const menu = (label, submenu) => ({label, submenu: submenu.filter(truep)})
    const stop_auto_and = f => ((...a) => {stop_auto(); f(...a)})
    const ask_sec = redoing => ((this_item, win) => ask_auto_play_sec(win, redoing))
    const item = (label, accelerator, click, standalone_only, enabled, keep_auto) =>
          !(standalone_only && attached) && {
              label, accelerator, click: keep_auto ? click : stop_auto_and(click),
              enabled: enabled || (enabled === undefined)
          }
    const sep = {type: 'separator'}
    const insert_if = (pred, ...items) => pred ? items : []
    const file_menu = menu('File', [
        item('New empty board', 'CmdOrCtrl+N', new_empty_board, true),
        item('New handicap game', undefined, ask_handicap_stones, true),
        item('New window', 'CmdOrCtrl+Shift+N',
             (this_item, win) => new_window(window_prop(win).board_type === 'suggest' ?
                                            'variation' : 'suggest')),
        item('Open SGF...', 'CmdOrCtrl+O', open_sgf, true),
        item('Save SGF...', 'CmdOrCtrl+S', save_sgf, true),
        sep,
        item('Reset', 'CmdOrCtrl+R', restart),
        leelaz_for_white ?
            item('Load weights for black', 'Shift+L', load_leelaz_for_black) :
            item('Load network weights', 'Shift+L', load_weight),
        sep,
        item('Close', undefined, (this_item, win) => win.close()),
        item('Quit', undefined, app.quit),
    ])
    const edit_menu = menu('Edit', [
        item('Copy SGF', 'CmdOrCtrl+C', copy_sgf_to_clipboard, true),
        item('Paste SGF', 'CmdOrCtrl+V', paste_sgf_from_clipboard, true),
        sep,
        item('Delete board', 'CmdOrCtrl+X', cut_sequence, true),
        item('Undelete board', 'CmdOrCtrl+Z', uncut_sequence, true,
             exist_deleted_sequence()),
        item('Duplicate board', 'CmdOrCtrl+D', duplicate_sequence, true),
        sep,
        {label: 'Trial board', type: 'checkbox', checked: history.trial,
         click: toggle_trial},
    ])
    const view_menu = menu('View', [
        board_type_menu_item('Two boards A (main+PV)', 'double_boards', win),
        board_type_menu_item('Two boards B (main+raw)', 'double_boards_raw', win),
        board_type_menu_item('Two boards C (raw+sub)', 'double_boards_swap', win),
        board_type_menu_item('Two boards D (raw+PV)', 'double_boards_raw_pv', win),
        board_type_menu_item('Suggestions', 'suggest', win),
        board_type_menu_item('Principal variation', 'variation', win),
        board_type_menu_item('Raw board', 'raw', win),
        board_type_menu_item('Winrate graph', 'winrate_only', win),
        sep,
        store_toggler_menu_item('Let me think first', 'let_me_think', 'Shift+M',
                                toggle_let_me_think),
        sep,
        store_toggler_menu_item('Lizzie style', 'lizzie_style'),
        store_toggler_menu_item('Expand winrate bar', 'expand_winrate_bar', 'Shift+B'),
        ...insert_if(leelaz_for_endstate,
            sep,
            store_toggler_menu_item(`Endstate (diff: ${endstate_diff_interval} moves)`, 'show_endstate', 'Shift+E'),
            item('...longer diff', '{', endstate_diff_interval_adder(10),
                 false, R.show_endstate, true),
            item('...shorter diff', '}', endstate_diff_interval_adder(-10),
                 false, R.show_endstate, true))
    ])
    const tool_menu = menu('Tool', [
        has_sabaki && {label: 'Attach Sabaki', type: 'checkbox', checked: attached,
                       accelerator: 'CmdOrCtrl+T', click: toggle_sabaki},
        item('Auto replay', 'Shift+A', ask_sec(true), true),
        item('Self play', 'Shift+P', ask_sec(false), true),
        {label: 'Alternative weights for white', accelerator: 'CmdOrCtrl+Shift+L',
         type: 'checkbox', checked: !!leelaz_for_white,
         click: stop_auto_and(leelaz_for_white ?
                              unload_leelaz_for_white : load_leelaz_for_white)},
        leelaz_for_white ?
            item('Swap black/white weights', 'Shift+S',
                 swap_leelaz_for_black_and_white) :
            item('Switch to previous weights', 'Shift+S',
                 switch_to_previous_weight, false, !!previous_weight_file),
        item('Info', 'CmdOrCtrl+I', info),
    ])
    const debug_menu = menu('Debug', [
        store_toggler_menu_item('Debug log', debug_log_key, null, toggle_debug_log),
        {role: 'toggleDevTools'},
    ])
    const help_menu = menu('Help', [
        item('Help', undefined, help),
    ])
    return [file_menu, edit_menu, view_menu, tool_menu, debug_menu, help_menu]
}

function board_type_menu_item(label, type, win) {
    return {label, type: 'radio', checked: window_prop(win).board_type === type,
            click: (this_item, win) => set_board_type(type, win)}
}

function store_toggler_menu_item(label, key, accelerator, on_click) {
    const toggle_it = () => toggle_stored(key)
    return {label, accelerator, type: 'checkbox', checked: store.get(key),
            click: on_click || toggle_it}
}

function toggle_stored(key) {
    store.set(key, !store.get(key)); update_state(); return store.get(key)
}
