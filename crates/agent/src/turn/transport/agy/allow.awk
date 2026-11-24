# agy asks this program before every tool call, with the call as JSON on standard input. It allows
# the call only when the tool's name is one of the comma-separated names in `allowed`.
#
# The name is found by its place, as the `name` member of the `toolCall` member of the outermost
# object, because the arguments and the user's message are in the same input and may hold text
# that only looks like it. The input must hold one `toolCall` with one `name`, and no key at those
# two levels may be written with a backslash, because such a key can spell `toolCall` or `name`
# in a way this program does not read.

# Reads the line in short pieces, because some awks take longer to cut a character out of a
# string the longer the string is.
{
    size = length($0)
    for (from = 1; from <= size; from += 512) {
        piece = substr($0, from, 512)
        count = length(piece)
        for (at = 1; at <= count; at++) read(substr(piece, at, 1))
    }
}

function read(char) {
    if (in_string) {
        if (is_escaped) {
            is_escaped = 0
        } else if (char == "\\") {
            is_escaped = 1
            has_backslash = 1
        } else if (char == "\"") {
            in_string = 0
            # No key or name that matters is this long, so a longer one is not kept.
            if (is_long) word = ""
            if (is_object[depth] && wants_key[depth]) {
                key[depth] = word
                wants_key[depth] = 0
                if (depth <= 2 && has_backslash) escaped_keys++
                if (depth == 1 && word == "toolCall") tool_calls++
                if (depth == 2 && is_object[1] && key[1] == "toolCall" && word == "name") name_keys++
            } else if (depth == 2 && is_object[1] && is_object[2] && key[1] == "toolCall" && key[2] == "name") {
                names++
                name = word
            }
            return
        }
        if (length(word) < 100) word = word char
        else is_long = 1
    } else if (char == "\"") {
        in_string = 1
        is_long = 0
        has_backslash = 0
        word = ""
    } else if (char == "{") {
        depth++
        is_object[depth] = 1
        wants_key[depth] = 1
        key[depth] = ""
    } else if (char == "[") {
        depth++
        is_object[depth] = 0
    } else if (char == "}" || char == "]") {
        depth--
    } else if (char == "," && is_object[depth]) {
        wants_key[depth] = 1
    }
}

END {
    is_allowed = 0
    is_plain = (tool_calls == 1 && name_keys == 1 && names == 1 && escaped_keys == 0)
    count = split(allowed, list, ",")
    for (item = 1; item <= count; item++) {
        if (is_plain && name != "" && name == list[item]) is_allowed = 1
    }
    if (is_allowed) {
        print "{\"decision\":\"allow\"}"
    } else {
        print "{\"decision\":\"deny\",\"reason\":\"Jet allows only its own tools in this chat.\"}"
    }
}
