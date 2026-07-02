cmake_minimum_required(VERSION 3.16)
project(cmake_app_fixture)

set(CMAKE_CXX_STANDARD 17)

add_subdirectory(packages/shared)
add_subdirectory(apps/server)
add_subdirectory(apps/tool)
