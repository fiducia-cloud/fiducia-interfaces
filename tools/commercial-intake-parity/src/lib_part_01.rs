use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Write as _};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParityError(String);

impl ParityError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<String> for ParityError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ParityError {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Display for ParityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ParityError {}

pub type Result<T> = std::result::Result<T, ParityError>;

#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl JsonValue {
    pub fn as_object(&self, label: &str) -> Result<&BTreeMap<String, JsonValue>> {
        match self {
            Self::Object(value) => Ok(value),
            _ => Err(ParityError::new(format!("{label} must be an object"))),
        }
    }

    pub fn as_array(&self, label: &str) -> Result<&[JsonValue]> {
        match self {
            Self::Array(value) => Ok(value),
            _ => Err(ParityError::new(format!("{label} must be an array"))),
        }
    }

    pub fn as_str(&self, label: &str) -> Result<&str> {
        match self {
            Self::String(value) => Ok(value),
            _ => Err(ParityError::new(format!("{label} must be a string"))),
        }
    }
}

struct JsonParser<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input: input.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<JsonValue> {
        self.skip_whitespace();
        let value = self.parse_value()?;
        self.skip_whitespace();
        if self.position != self.input.len() {
            return Err(self.error("unexpected trailing JSON content"));
        }
        Ok(value)
    }

    fn parse_value(&mut self) -> Result<JsonValue> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'n') => {
                self.consume_keyword(b"null")?;
                Ok(JsonValue::Null)
            }
            Some(b't') => {
                self.consume_keyword(b"true")?;
                Ok(JsonValue::Bool(true))
            }
            Some(b'f') => {
                self.consume_keyword(b"false")?;
                Ok(JsonValue::Bool(false))
            }
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-' | b'0'..=b'9') => self.parse_number().map(JsonValue::Number),
            Some(_) => Err(self.error("unexpected JSON token")),
            None => Err(self.error("unexpected end of JSON input")),
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue> {
        self.expect(b'{')?;
        self.skip_whitespace();
        let mut object = BTreeMap::new();
        if self.consume_if(b'}') {
            return Ok(JsonValue::Object(object));
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();
            let value = self.parse_value()?;
            if object.insert(key.clone(), value).is_some() {
                return Err(self.error(&format!("duplicate JSON object key {key:?}")));
            }
            self.skip_whitespace();
            if self.consume_if(b'}') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(JsonValue::Object(object))
    }

    fn parse_array(&mut self) -> Result<JsonValue> {
        self.expect(b'[')?;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.consume_if(b']') {
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.parse_value()?);
            self.skip_whitespace();
            if self.consume_if(b']') {
                break;
            }
            self.expect(b',')?;
            self.skip_whitespace();
        }
        Ok(JsonValue::Array(values))
    }

    fn parse_string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut output = String::new();
        while let Some(byte) = self.next() {
            match byte {
                b'"' => return Ok(output),
                b'\\' => match self.next() {
                    Some(b'"') => output.push('"'),
                    Some(b'\\') => output.push('\\'),
                    Some(b'/') => output.push('/'),
                    Some(b'b') => output.push('\u{0008}'),
                    Some(b'f') => output.push('\u{000c}'),
                    Some(b'n') => output.push('\n'),
                    Some(b'r') => output.push('\r'),
                    Some(b't') => output.push('\t'),
                    Some(b'u') => output.push(self.parse_unicode_escape()?),
                    Some(_) => return Err(self.error("invalid JSON string escape")),
                    None => return Err(self.error("unterminated JSON string escape")),
                },
                0x00..=0x1f => return Err(self.error("unescaped control byte in JSON string")),
                0x20..=0x7f => output.push(char::from(byte)),
                _ => {
                    let width = utf8_width(byte);
                    if width == 0 || self.position + width.saturating_sub(1) > self.input.len() {
                        return Err(self.error("invalid UTF-8 in JSON string"));
                    }
                    let start = self.position - 1;
                    let end = start + width;
                    let text = std::str::from_utf8(&self.input[start..end])
                        .map_err(|_| self.error("invalid UTF-8 in JSON string"))?;
                    output.push_str(text);
                    self.position = end;
                }
            }
        }
        Err(self.error("unterminated JSON string"))
    }

    fn parse_unicode_escape(&mut self) -> Result<char> {
        let value = self.parse_hex_quad()?;
        if (0xd800..=0xdbff).contains(&value) {
            self.expect(b'\\')?;
            self.expect(b'u')?;
            let low = self.parse_hex_quad()?;
            if !(0xdc00..=0xdfff).contains(&low) {
                return Err(self.error("invalid low surrogate in JSON string"));
            }
            let scalar = 0x1_0000 + (((value - 0xd800) as u32) << 10) + (low - 0xdc00) as u32;
            return char::from_u32(scalar)
                .ok_or_else(|| self.error("invalid Unicode scalar in JSON string"));
        }
        if (0xdc00..=0xdfff).contains(&value) {
            return Err(self.error("unexpected low surrogate in JSON string"));
        }
        char::from_u32(value as u32)
            .ok_or_else(|| self.error("invalid Unicode scalar in JSON string"))
    }

    fn parse_hex_quad(&mut self) -> Result<u16> {
        let mut value = 0_u16;
        for _ in 0..4 {
            let digit = match self.next() {
                Some(b'0'..=b'9') => u16::from(self.input[self.position - 1] - b'0'),
                Some(b'a'..=b'f') => u16::from(self.input[self.position - 1] - b'a' + 10),
                Some(b'A'..=b'F') => u16::from(self.input[self.position - 1] - b'A' + 10),
                _ => return Err(self.error("invalid hexadecimal JSON escape")),
            };
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<String> {
        let start = self.position;
        self.consume_if(b'-');
        match self.peek() {
            Some(b'0') => {
                self.position += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.error("leading zero in JSON number"));
                }
            }
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(self.error("invalid JSON number")),
        }
        if self.consume_if(b'.') {
            let fraction_start = self.position;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == fraction_start {
                return Err(self.error("JSON fraction requires digits"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let exponent_start = self.position;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == exponent_start {
                return Err(self.error("JSON exponent requires digits"));
            }
        }
        String::from_utf8(self.input[start..self.position].to_vec())
            .map_err(|_| self.error("invalid UTF-8 in JSON number"))
    }

    fn consume_keyword(&mut self, keyword: &[u8]) -> Result<()> {
        if self.input.get(self.position..self.position + keyword.len()) == Some(keyword) {
            self.position += keyword.len();
            Ok(())
        } else {
            Err(self.error("invalid JSON keyword"))
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<()> {
        if self.consume_if(byte) {
            Ok(())
        } else {
            Err(self.error(&format!("expected byte {:?}", char::from(byte))))
        }
    }

    fn consume_if(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.position).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let value = self.peek()?;
        self.position += 1;
        Some(value)
    }

    fn error(&self, message: &str) -> ParityError {
        ParityError::new(format!("{message} at byte {}", self.position))
    }
}

fn utf8_width(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    }
}

pub fn parse_json(input: &str) -> Result<JsonValue> {
    JsonParser::new(input).parse()
}

fn escape_json_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{001f}' => {
                write!(output, "\\u{:04x}", character as u32)
                    .expect("writing to a String cannot fail");
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

fn render_json(value: &JsonValue, output: &mut String, depth: usize) {
    match value {
        JsonValue::Null => output.push_str("null"),
        JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        JsonValue::Number(value) => output.push_str(value),
        JsonValue::String(value) => escape_json_string(value, output),
        JsonValue::Array(values) => {
            if values.is_empty() {
                output.push_str("[]");
                return;
            }
            output.push_str("[\n");
            for (index, value) in values.iter().enumerate() {
                output.push_str(&"  ".repeat(depth + 1));
                render_json(value, output, depth + 1);
                if index + 1 != values.len() {
                    output.push(',');
                }
                output.push('\n');
            }
            output.push_str(&"  ".repeat(depth));
            output.push(']');
        }
        JsonValue::Object(values) => {
            if values.is_empty() {
                output.push_str("{}");
                return;
            }
            output.push_str("{\n");
            for (index, (key, value)) in values.iter().enumerate() {
                output.push_str(&"  ".repeat(depth + 1));
                escape_json_string(key, output);
                output.push_str(": ");
                render_json(value, output, depth + 1);
                if index + 1 != values.len() {
                    output.push(',');
                }
                output.push('\n');
            }
            output.push_str(&"  ".repeat(depth));
            output.push('}');
        }
    }
}

pub fn render_json_pretty(value: &JsonValue) -> String {
    let mut output = String::new();
    render_json(value, &mut output, 0);
    output.push('\n');
    output
}
