package com.zcode.kb.mcp;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON 解析（RFC 8259 子集）与转义写出（CuaMiniJson 同款拷贝，包名换 kb）。
 *
 * KB MCP server 进程为纯 Java 零依赖设计（-cp 插件 lib\*，fork JVM 无 kotlin-stdlib，
 * 故 server 主体与 JSON 层整体 Java）。parse 返回 Map/List/String/Double/Boolean/null，
 * 数字统一 Double。
 */
final class KbMiniJson {

    private KbMiniJson() {
    }

    static Object parse(String text) {
        Parser p = new Parser(text);
        p.skipWs();
        Object v = p.parseValue();
        p.skipWs();
        if (p.pos < text.length()) {
            throw new IllegalArgumentException("trailing chars at " + p.pos);
        }
        return v;
    }

    private static final class Parser {
        final String s;
        int pos;

        Parser(String s) {
            this.s = s;
        }

        void skipWs() {
            while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) {
                pos++;
            }
        }

        Object parseValue() {
            if (pos >= s.length()) {
                throw new IllegalArgumentException("unexpected end");
            }
            char c = s.charAt(pos);
            switch (c) {
                case '{': return parseObj();
                case '[': return parseArr();
                case '"': return parseStr();
                case 't': return lit("true", Boolean.TRUE);
                case 'f': return lit("false", Boolean.FALSE);
                case 'n': return lit("null", null);
                default: return parseNum();
            }
        }

        Object lit(String word, Object v) {
            if (!s.startsWith(word, pos)) {
                throw new IllegalArgumentException("bad literal at " + pos);
            }
            pos += word.length();
            return v;
        }

        Map<String, Object> parseObj() {
            pos++; // {
            Map<String, Object> m = new LinkedHashMap<>();
            skipWs();
            if (pos < s.length() && s.charAt(pos) == '}') {
                pos++;
                return m;
            }
            while (true) {
                skipWs();
                String k = parseStr();
                skipWs();
                if (s.charAt(pos) != ':') {
                    throw new IllegalArgumentException("expect : at " + pos);
                }
                pos++;
                skipWs();
                m.put(k, parseValue());
                skipWs();
                char c = s.charAt(pos);
                if (c == ',') {
                    pos++;
                } else if (c == '}') {
                    pos++;
                    return m;
                } else {
                    throw new IllegalArgumentException("expect , or } at " + pos);
                }
            }
        }

        List<Object> parseArr() {
            pos++; // [
            List<Object> l = new ArrayList<>();
            skipWs();
            if (pos < s.length() && s.charAt(pos) == ']') {
                pos++;
                return l;
            }
            while (true) {
                skipWs();
                l.add(parseValue());
                skipWs();
                char c = s.charAt(pos);
                if (c == ',') {
                    pos++;
                } else if (c == ']') {
                    pos++;
                    return l;
                } else {
                    throw new IllegalArgumentException("expect , or ] at " + pos);
                }
            }
        }

        String parseStr() {
            if (s.charAt(pos) != '"') {
                throw new IllegalArgumentException("expect string at " + pos);
            }
            pos++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(pos);
                if (c == '"') {
                    pos++;
                    return sb.toString();
                }
                if (c == '\\') {
                    pos++;
                    char e = s.charAt(pos);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            sb.append((char) Integer.parseInt(s.substring(pos + 1, pos + 5), 16));
                            pos += 4;
                            break;
                        default: throw new IllegalArgumentException("bad escape \\" + e + " at " + pos);
                    }
                    pos++;
                } else {
                    sb.append(c);
                    pos++;
                }
            }
        }

        Double parseNum() {
            int start = pos;
            if (pos < s.length() && (s.charAt(pos) == '-' || s.charAt(pos) == '+')) {
                pos++;
            }
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (Character.isDigit(c) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    pos++;
                } else {
                    break;
                }
            }
            return Double.parseDouble(s.substring(start, pos));
        }
    }

    static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < ' ') {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    static String str(String s) {
        return "\"" + escape(s) + "\"";
    }

    /** stringify：Map/List/String/Double/Boolean/null → JSON 文本（parse 的逆，管理写路径用）。Double 整值输出无小数点——config version/entry 时间戳经 parse 变 Double 后写回须还原整数形态 */
    static String stringify(Object v) {
        StringBuilder sb = new StringBuilder();
        writeValue(sb, v);
        return sb.toString();
    }

    private static void writeValue(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            sb.append(str((String) v));
        } else if (v instanceof Boolean) {
            sb.append(v);
        } else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                sb.append((long) d);
            } else {
                sb.append(d);
            }
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append(str(String.valueOf(e.getKey()))).append(':');
                writeValue(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeValue(sb, o);
            }
            sb.append(']');
        } else {
            sb.append(str(String.valueOf(v)));
        }
    }

    /** 文本 result 信封 */
    static String textResult(String jsonText, boolean isError) {
        return "{\"content\":[{\"type\":\"text\",\"text\":" + str(jsonText)
            + "}],\"isError\":" + isError + "}";
    }
}
