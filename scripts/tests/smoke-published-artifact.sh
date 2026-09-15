#!/bin/sh
set -eu

target="${ZED_PKG_TEST_TARGET:?ZED_PKG_TEST_TARGET is required}"

test -f "$target/schema/index.json"
test -f "$target/sql/customer.sql"
