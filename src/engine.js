const CRYPTO = require('crypto')

function create_leelaz () {

    /////////////////////////////////////////////////
    // setup

    const endstate_delay_millisec = 20
    const speedo_interval_sec = 3, speedo_premature_sec = 0.5
    const speedometer = make_speedometer(speedo_interval_sec, speedo_premature_sec)
    const queue_log_header = 'queue>'

    let leelaz_process, arg, engine_id, is_ready = false, ownership_p = false
    let command_queue = [], last_command_id, last_response_id, pondering = true
    let on_response_for_id = {}
    let network_size_text = '', komi = leelaz_komi, gorule = default_gorule
    let startup_log = []

    // game state
    let move_count = 0, bturn = true

    // util
    const log = (header, s, show_queue_p) => {
        const t2s = task => (task.protect_p ? '!' : '') +
              (with_response_p(task) ? '*' : '') + task.command
        const message = `[${(leelaz_process || {}).pid}] ${header} ${s}`
        !is_ready && (header !== queue_log_header) && startup_log.push(message)
        debug_log(message +
                  (show_queue_p ? ` [${command_queue.map(t2s)}]` : ''),
                  arg && arg.engine_log_line_length || 500)
    }

    /////////////////////////////////////////////////
    // leelaz action

    // process
    const start = h => {
        arg = cook_arg(h); engine_id = hash(JSON.stringify(arg))
        const {leelaz_command, leelaz_args, analyze_interval_centisec, wait_for_startup,
               weight_file, working_dir, default_board_size,
               minimum_suggested_moves, engine_log_line_length, ready_handler,
               endstate_handler, suggest_handler, restart_handler, error_handler,
               illegal_handler, tuning_handler, unsupported_size_handler}
              = arg || {}
        const opt = {cwd: working_dir}
        is_ready = false; startup_log = []; network_size_text = ''
        log('start engine:', JSON.stringify(arg && [leelaz_command, ...leelaz_args]))
        leelaz_process = require('child_process').spawn(leelaz_command, leelaz_args, opt)
        leelaz_process.stdout.on('data', each_line(stdout_reader))
        leelaz_process.stderr.on('data', each_line(reader))
        set_error_handler(leelaz_process, () => restart_handler(startup_log))
        command_queue = []; last_command_id = last_response_id = -1
        wait_for_startup || on_ready()
    }
    const restart = h => {kill(); start(h ? {...arg, ...h} : arg)}
    const kill = () => {
        if (!leelaz_process) {return}
        ['stdin', 'stdout', 'stderr']
            .forEach(k => leelaz_process[k].removeAllListeners())
        leelaz_process.removeAllListeners()
        set_error_handler(leelaz_process, e => {})
        leelaz_process.kill('SIGKILL')
    }

    const start_analysis = () => {
        pondering && leelaz([
            is_katago() ? 'kata-analyze' : 'lz-analyze',
            `interval ${arg.analyze_interval_centisec}`,
            is_katago() && ownership_p && 'ownership true',
            is_supported('minmoves') && `minmoves ${arg.minimum_suggested_moves}`,
        ].filter(truep).join(' '))
    }
    const stop_analysis = () => {leelaz('name')}
    const set_pondering = bool => {
        bool !== pondering && ((pondering = bool) ? start_analysis() : stop_analysis())
    }
    const endstate = () => {
        arg.endstate_handler && is_supported('endstate') && leelaz('endstate_map')
    }

    let on_ready = () => {
        if (is_ready) {return}; is_ready = true
        const checks = [['minmoves', 'lz-analyze interval 1 minmoves 30'],
                        ['lz-setoption', 'lz-setoption name visits value 0'],
                        ['endstate', 'endstate_map'],
                        ['kata-analyze', 'kata-analyze interval 1'],
                        ['kata-set-rules', `kata-set-rules ${gorule}`]]
        checks.map(a => check_supported(...a))
        // clear_leelaz_board for restart
        // komi may be changed tentatively in set_board before check of engine type
        const after_all_checks = () => {
            clear_leelaz_board(); is_katago() || (komi = leelaz_komi)
            arg.ready_handler()
        }
        leelaz('lizgoban_after_all_checks', after_all_checks)
    }
    const on_error = () =>
          (arg.error_handler || arg.restart_handler)(startup_log)

    // stateless wrapper of leelaz
    let leelaz_previous_history = []
    const set_board = (history, new_komi, new_gorule, new_ownership_p) => {
        change_board_size(board_size())
        let update_kata_p = false
        const update_kata = (val, new_val, command) => {
            const update_p = is_katago(true) && truep(new_val) && new_val !== val
            if (!update_p) {return val}
            command && leelaz(`${command} ${new_val}`)
            update_kata_p = true; return new_val
        }
        komi = update_kata(komi, new_komi, 'komi')
        gorule = update_kata(gorule, new_gorule, 'kata-set-rules')
        ownership_p = update_kata(ownership_p, new_ownership_p)
        if (empty(history)) {clear_leelaz_board(); update_move_count([]); return}
        const beg = common_header_length(history, leelaz_previous_history)
        const back = leelaz_previous_history.length - beg
        const rest = history.slice(beg)
        do_ntimes(back, undo1); rest.forEach(play1)
        if (back > 0 || !empty(rest) || update_kata_p) {update_move_count(history)}
        leelaz_previous_history = history.slice()
    }
    const play1 = h => {
        const {move, is_black} = h
        const f = ok => !ok && !h.illegal && ((h.illegal = true), arg.illegal_handler(h))
        leelaz('play ' + (is_black ? 'b ' : 'w ') + move, f)
    }
    const undo1 = () => {leelaz('undo')}
    let old_board_size
    const change_board_size = (new_size, on_response) => {
        const bsize = board_size(); if (bsize === old_board_size) {return}
        const ng = () => {arg.unsupported_size_handler(); old_board_size = null}
        const f = ok => {is_ready = true; ok || ng(); arg.ready_handler(true)}
        is_ready = false; leelaz(`boardsize ${bsize}`, f); old_board_size = bsize
    }

    // util
    const leelaz = (command, on_response, protect_p) => {
        log(queue_log_header, command, true); send_to_queue({command, on_response, protect_p})
    }
    const update_now = () => arg && (endstate(), start_analysis())
    const [update_later] = deferred_procs([update_now, endstate_delay_millisec])
    // avoid flicker of endstate
    const update = () => is_supported('endstate') ? update_later() : update_now()
    const clear_leelaz_board = () => {leelaz("clear_board"); leelaz_previous_history = []; update()}
    const start_args = () => arg
    const network_size = () => network_size_text
    const get_komi = () => komi
    const peek_value = (move, cont) => {
        if (!is_supported('lz-setoption')) {return false}
        the_nn_eval_reader =
            value => {the_nn_eval_reader = do_nothing; cont(value); update()}
        leelaz(join_commands('lz-setoption name visits value 1',
                             `play ${bturn ? 'b' : 'w'} ${move}`,
                             'lz-analyze interval 0',
                             'lz-setoption name visits value 0', 'undo'))
        return true
    }

    /////////////////////////////////////////////////
    // weights file

    const cook_arg = h => {
        if (!h) {return h}
        // weight file
        const leelaz_args = h.leelaz_args.slice()
        h.weight_file &&
            (leelaz_args[weight_option_pos_in_leelaz_args(h)] = h.weight_file)
        // board size (KataGo)
        const bsize_pattern = /defaultBoardSize=[0-9]+/
        const bsize_replaced = `defaultBoardSize=${h.default_board_size}`
        const bsize_pos = leelaz_args.findIndex(v => v.match(bsize_pattern))
        h.default_board_size && bsize_pos >= 0 &&
            (leelaz_args[bsize_pos] =
             leelaz_args[bsize_pos].replace(bsize_pattern, bsize_replaced))
        return {...h, leelaz_args}
    }
    const start_args_equal = h => {
        const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
        // const eq = (a, b) => a === b ||
        //       (typeof a === 'object' && typeof b === 'object' &&
        //        Object.keys({...a, ...b}).every(k => eq(a[k], b[k])))
        return eq(arg, cook_arg(h))
    }
    const get_weight_file = () =>
          arg && arg.leelaz_args[weight_option_pos_in_leelaz_args(arg)]
    const weight_option_pos_in_leelaz_args = h => {
        const weight_options = ['-w', '--weights', '-model']  // -model for KataGo
        return h.leelaz_args.findIndex(z => weight_options.includes(z)) + 1
    }

    /////////////////////////////////////////////////
    // command queue

    // task = {command: "play b D4", on_response: ok => {...}, protect_p: false}

    const send_to_queue = task => {
        const remove = f => {
            command_queue = command_queue.filter(x => !f(x) || x.protect_p)
        }
        // useless lz-analyze that will be canceled immediately
        remove(pondering_command_p)
        // duplicated endstate
        endstate_command_p(task) && remove(endstate_command_p)
        // obsolete endstate / peek
        changer_command_p(task) && [endstate_command_p, peek_command_p].forEach(remove)
        clear_command_p(task) && remove(changer_command_p)
        command_queue.push(task); send_from_queue()
    }

    const send_from_queue = () => {
        if (empty(command_queue) || !up_to_date_response()) {return}
        split_task(command_queue.shift()).forEach(send_task_to_leelaz)
    }

    const send_task_to_leelaz = task => {
        // see stdout_reader for optional "on_response"
        const {command, on_response} = task
        const cmd = dummy_command_p(task) ? 'name' : command
        const cmd_with_id = `${++last_command_id} ${cmd}`
        with_response_p(task) && (on_response_for_id[last_command_id] = on_response)
        pondering_command_p(task) && speedometer.reset()
        log('leelaz> ', cmd_with_id, true); leelaz_process.stdin.write(cmd_with_id + "\n")
    }
    // ignore unintentional wrong on_response by a.forEach(send_to_leelaz)
    const with_response_p = task => (typeof task.on_response === 'function')
    const send_to_leelaz = (command, on_response) =>
          send_task_to_leelaz({command, on_response})

    const update_move_count = history => {
        const new_state =
              {move_count: history.length, bturn: !(last(history) || {}).is_black}
        const dummy_command = `lizgoban_set ${JSON.stringify(new_state)}`
        const on_response = () => ({move_count, bturn} = new_state)
        leelaz(dummy_command, on_response); update()
    }

    const join_commands = (...a) => a.join(';')
    const split_task = task => {
        const ts = task.command.split(';').map(command => ({command}))
        last(ts).on_response = task.on_response
        return ts
    }
    const up_to_date_response = () => {return last_response_id >= last_command_id}

    const command_matcher = re => (task => task.command.match(re))
    const pondering_command_p = command_matcher(/^(lz|kata)-analyze/)
    const endstate_command_p = command_matcher(/^endstate_map/)
    const peek_command_p = command_matcher(/play.*undo/)
    const changer_command_p = command_matcher(/play|undo|clear_board/)
    const clear_command_p = command_matcher(/clear_board/)
    const dummy_command_p = command_matcher(/lizgoban/)

    /////////////////////////////////////////////////
    // stdout reader

    // suggest = [suggestion_data, ..., suggestion_data]
    // suggestion_data =
    //   {move: "Q16", visits: 17, winrate: 52.99, order: 4, winrate_order: 3, pv: v} etc.
    // v = ["Q16", "D4", "Q3", ..., "R17"] etc.

    const stdout_reader = (s) => {
        log('stdout|', s)
        const m = s.match(/^([=?])(\d+)/)
        if (m) {
            const ok = (m[1] === '='), id = last_response_id = to_i(m[2])
            const on_response = on_response_for_id[id]
            on_response && (on_response(ok), delete on_response_for_id[id])
        }
        up_to_date_response() && s.match(/^info /) && suggest_reader(s)
        send_from_queue()
    }

    const suggest_reader = (s) => {
        if (!arg.suggest_handler) {return}
        const [i_str, o_str] = s.split(/\s*ownership\s*/)
        const ownership = ownership_parser(o_str)
        const unsorted_suggest =
              i_str.split(/info/).slice(1).map(suggest_parser).filter(truep)
        const suggest = sort_by_key(unsorted_suggest, 'order')
        const [wsum, visits, scsum] =
              suggest.map(h => [h.winrate, h.visits, h.score_without_komi || 0])
              .reduce(([ws, vs, scs], [w, v, sc]) => [ws + w * v, vs + v, scs + sc * v],
                      [0, 0, 0])
        const winrate = wsum / visits, b_winrate = bturn ? winrate : 100 - winrate
        const visits_per_sec = speedometer.per_sec(visits)
        const score_without_komi = is_katago() && (scsum / visits)
        const add_order = (sort_key, order_key) => sort_by_key(suggest, sort_key)
              .reverse().forEach((h, i) => (h[order_key] = i))
        // winrate is NaN if suggest = []
        add_order('visits', 'visits_order')
        add_order('winrate', 'winrate_order')
        arg.suggest_handler({engine_id, suggest, visits, b_winrate, visits_per_sec,
                             score_without_komi, ownership})
    }

    // (sample of leelaz output for "lz-analyze 10")
    // info move D16 visits 23 winrate 4668 prior 2171 order 0 pv D16 Q16 D4 Q3 R5 R4 Q5 O3 info move D4 visits 22 winrate 4670 prior 2198 order 1 pv D4 Q4 D16 Q17 R15 R16 Q15 O17 info move Q16 visits 21 winrate 4663 prior 2147 order 2 pv Q16 D16 Q4 D3 C5 C4 D5 F3
    // (sample with "pass")
    // info move pass visits 65 winrate 0 prior 340 order 0 pv pass H4 pass H5 pass G3 pass G1 pass
    // (sample of LCB)
    // info move D4 visits 171 winrate 4445 prior 1890 lcb 4425 order 0 pv D4 Q16 Q4 D16
    // (sample "kata-analyze interval 10 ownership true")
    // info move D17 visits 2 utility 0.0280885 winrate 0.487871 scoreMean -0.773097 scoreStdev 32.7263 prior 0.105269 order 0 pv D17 C4 ... pv D17 R16 ownership -0.0261067 -0.0661169 ... 0.203051
    const suggest_parser = (s) => {
        const to_percent = str => to_f(str) * (is_katago() ? 100 : 1/100)
        const [a, b] = s.split(/pv/); if (!b) {return false}
        const h = array2hash(a.trim().split(/\s+/))
        h.pv = b.trim().split(/\s+/); h.lcb = to_percent(h.lcb || h.winrate)
        h.visits = to_i(h.visits); h.order = to_i(h.order)
        h.winrate = to_percent(h.winrate); h.prior = to_percent(h.prior) / 100
        truep(h.scoreMean) &&
            (h.score_without_komi = h.scoreMean * (bturn ? 1 : -1) + komi)
        h.scoreStdev = to_f(h.scoreStdev || 0)
        return h
    }
    const ownership_parser = s => s && s.trim().split(/\s+/)
          .map(z => to_f(z) * (bturn ? 1 : -1))

    /////////////////////////////////////////////////
    // stderr reader

    let current_reader, the_nn_eval_reader = do_nothing

    const reader = (s) => {log('stderr|', s); current_reader(s)}

    const main_reader = (s) => {
        let m, c;
        (arg.tuning_handler || do_nothing)(s);
        (m = s.match(/Detecting residual layers.*?([0-9]+) channels.*?([0-9]+) blocks/)) &&
            (network_size_text = `${m[1]}x${m[2]}`);
        (m = s.match(/Model name: g[0-9]+-b([0-9]+)c([0-9]+)-s[0-9]+-d.[0-9]+/)) &&
            (network_size_text = `${m[2]}x${m[1]}`);
        // "GTP ready" for KataGo
        s.match(/(Setting max tree size)|(GTP ready)/) && on_ready();
        s.match(/Weights file is the wrong version/) && on_error();
        (m = s.match(/NN eval=([0-9.]+)/)) && the_nn_eval_reader(to_f(m[1]));
        s.match(/endstate:/) && (current_reader = endstate_reader)
    }

    current_reader = main_reader

    /////////////////////////////////////////////////
    // reader helper

    const multiline_reader = (parser, finisher) => {
        let buf = []
        return s => {
            const p = parser(s)
            p ? buf.push(p) : (finisher(buf), buf = [], current_reader = main_reader)
        }
    }

    /////////////////////////////////////////////////
    // endstate reader

    const finish_endstate_reader = (endstate) => {
        const f = arg.endstate_handler
        f && f({endstate, endstate_move_count: move_count})
    }

    const parse_endstate_line = (line) => {
        const b_endstate = s => to_i(s) / 1000
        return !line.match(/endstate sum/) && line.trim().split(/\s+/).map(b_endstate)
    }

    const endstate_reader = multiline_reader(parse_endstate_line, finish_endstate_reader)

    /////////////////////////////////////////////////
    // feature checker

    let supported = {}
    const check_supported =
          (feature, cmd) => leelaz(cmd, ok => (supported[feature] = ok), true)
    const is_supported = feature => supported[feature]
    const is_katago = maybe => is_supported('kata-analyze') || (!is_ready && maybe)

    /////////////////////////////////////////////////
    // exported methods

    return {
        start, restart, kill, set_board, update, set_pondering, get_weight_file,
        start_args, start_args_equal, get_komi, network_size, peek_value, is_katago,
        is_supported, clear_leelaz_board,
        endstate, is_ready: () => is_ready, engine_id: () => engine_id,
        // for debug
        send_to_leelaz,
    }

}  // end create_leelaz

function hash(str) {
    return CRYPTO.createHash('sha256').update(str).digest('hex').slice(0, 8)
}

/////////////////////////////////////////////////
// exports

module.exports = {create_leelaz}
