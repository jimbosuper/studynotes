---
title: "CMake构建系统"
category: "05-后端"
---

# CMake构建系统

> 这篇从 CMake 的配置/构建两阶段模型讲起，经过安装、最小工程、target 依赖、多目录组织、编译选项，最后落到第三方依赖、安装导出、测试排障和一个可被 `find_package` 消费的完整工程。
>
> 学完能把一个散落的源码目录改造成有库、有可执行文件、有测试、可安装、可被其他项目引用的 CMake 工程。

## 一、CMake 的模型：以 target 为中心

CMake 不是「更高级的 Makefile」，它是一套元构建系统：先根据 `CMakeLists.txt` 生成平台相关的构建文件（Ninja、Makefile、Visual Studio 工程），再由构建工具执行编译链接。

### 1.1 配置阶段与构建阶段

```mermaid
graph LR
  A[CMakeLists.txt] -->|cmake -S . -B build| B[配置阶段]
  B -->|生成| C[build.ninja / Makefile]
  C -->|cmake --build build| D[编译 + 链接]
  D --> E[可执行文件 / 库]
  B -->|探测| F[编译器 / 依赖 / 平台]
  F --> B
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B blue;
  class C amber;
  class D,E green;
  class F gray;
```

两个阶段分开带来三个直接结果：

- 配置只在 `CMakeLists.txt` 变化或手动重跑时执行，日常构建只跑第二阶段；
- 配置阶段能访问编译器信息、系统库、包管理器，适合做条件判断；
- 配置结果缓存在 `build/CMakeCache.txt`，缓存与源码不一致是排障的第一嫌疑。

判断命令该用哪条，只看目标：

| 目标 | 命令 |
|---|---|
| 首次配置 | `cmake -S . -B build` |
| 重新配置 | `cmake -S . -B build`（可重复执行） |
| 构建 | `cmake --build build -j 8` |
| 跑测试 | `ctest --test-dir build --output-on-failure` |
| 安装 | `cmake --install build --prefix /opt/app` |

### 1.2 target 是唯一的一等公民

现代 CMake（3.x 之后）的核心规则：**一切围绕 target**。源文件、头文件路径、编译选项、依赖库都挂在 target 上，而不是全局变量。

```cmake
# 推荐：属性跟着 target 走
add_library(units src/convert.cpp)
target_include_directories(units PUBLIC include)
target_compile_features(units PUBLIC cxx_std_20)

# 不推荐：全局设置影响所有 target，无法表达差异
include_directories(include)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++20")
```

全局变量的坏处不是「不优雅」，而是不可组合：A 库要求 C++17、B 库要求 C++20 时，全局只能有一个值；`target_compile_features` 会取所有依赖的最大值，由 CMake 计算。

### 1.3 target 的类型与传递性

| 类型 | 产物 | 典型用途 |
|---|---|---|
| `STATIC` | `.a` / `.lib` | 内部库，默认 |
| `SHARED` | `.so` / `.dylib` / `.dll` | 对外发布、插件 |
| `MODULE` | 运行期加载的库 | 插件，不参与链接 |
| `INTERFACE` | 无产物，只有属性 | 头文件库、编译选项集合 |
| `OBJECT` | `.o` 集合 | 同一份源码给多个 target 复用 |

`add_library(units src/convert.cpp)` 不写类型时由 `BUILD_SHARED_LIBS` 决定，默认 `STATIC`。发布给外部使用时显式写类型，避免使用方一改全局变量就改变链接方式。

> 边界：`INTERFACE` 库没有源文件，只能挂属性；给 `INTERFACE` target 加 `target_sources` 必须写成 `INTERFACE` 作用域，否则配置阶段报错。

## 二、安装与最小工程

CMake 本身是单个可执行文件，安装成本低；难点在于让同一份 `CMakeLists.txt` 在三个平台上都能找到编译器。

### 2.1 安装

| 环境 | 安装方式（2026-11） | 验证 |
|---|---|---|
| Windows 10/11 | `winget install Kitware.CMake Kitware.Ninja`，或官网 msi | `cmake --version` / `ninja --version` |
| macOS | `brew install cmake ninja` | `cmake --version` / `ninja --version` |
| Ubuntu 24.04/26.04 | `sudo apt install cmake ninja-build` | `cmake --version` / `ninja --version` |
| Rocky/CentOS 9/10 | `sudo dnf install cmake ninja-build` | `cmake --version` / `ninja --version` |

同时装一个生成器（generator）：Ninja 比 Unix Makefiles 快，且输出更干净。Ubuntu 的 `cmake` 包版本可能偏旧，需要新版本时用 Kitware 的 apt 源或 `pip install cmake`。

### 2.2 版本基线

| 组件 | 基线 | 说明 |
|---|---|---|
| CMake | 3.31+ | 4.x 也可用，但需注意兼容策略 |
| 生成器 | Ninja 1.12+ | 默认推荐 |
| 编译器 | GCC 14 / Clang 18 / MSVC 19.40 | 与 C++20 配套 |
| C++ 标准 | C++20 | 新项目默认 |

`cmake_minimum_required(VERSION 3.31)` 同时设定两件事：最低版本，以及策略（policy）兼容级别。写低了会按旧行为执行，写高了老环境直接拒绝配置。

### 2.3 最小工程

```text
hello/
├── CMakeLists.txt
└── main.cpp
```

```cmake
# hello/CMakeLists.txt
cmake_minimum_required(VERSION 3.31)
project(hello VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)   # 编译器不支持就报错，而不是悄悄降级
set(CMAKE_CXX_EXTENSIONS OFF)         # 关闭 GNU 扩展，保证可移植

add_executable(hello main.cpp)
```

```cpp
// hello/main.cpp
#include <iostream>

int main() {
    std::cout << "hello cmake\n";
}
```

```bash
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/hello
```

预期输出（配置阶段的编译器探测信息可能不同）：

```text
-- The CXX compiler identification is AppleClang 17.0.0.17.0.13.5
-- Configuring done
-- Generating done
-- Build files have been written to: /tmp/hello/build
[2/2] Linking CXX executable hello
hello cmake
```

`-S` 指定源码目录，`-B` 指定构建目录，两者分离叫 out-of-source 构建。所有生成物都在 `build/` 下，删掉目录即回到干净状态，源码目录永远不被污染。

> 边界：`cmake .`（源内构建）会生成 `CMakeCache.txt` 到源码目录，之后想改成 out-of-source 必须先删缓存。团队项目应把 `build/` 加进 `.gitignore`，并在文档里只写 `-S/-B` 形式。

## 三、target 与依赖关系

库与可执行文件的依赖必须显式声明，CMake 据此决定链接顺序和头文件搜索路径。

### 3.1 创建库与可执行文件

```cmake
add_library(units STATIC src/convert.cpp)
add_executable(units_cli app/main.cpp)
target_link_libraries(units_cli PRIVATE units)
```

`target_link_libraries` 不只是「加一个 `-l` 参数」，它同时把被依赖 target 的 `PUBLIC`/`INTERFACE` 属性（头文件目录、编译定义、编译特性）传递给使用方。手写 `-I` 和 `-L` 做不到这一点。

### 3.2 PUBLIC、PRIVATE 与 INTERFACE

三个关键字描述「属性的传播方向」：

| 关键字 | 自己用 | 使用方用 | 典型场景 |
|---|---|---|---|
| `PRIVATE` | 是 | 否 | 内部实现依赖 |
| `PUBLIC` | 是 | 是 | 公开头文件里出现的类型 |
| `INTERFACE` | 否 | 是 | 只有头文件的库 |

```cmake
add_library(units src/convert.cpp)

# 公开头文件在 include/，使用方也需要这个路径
target_include_directories(units
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>)

# 只在编译 units 自身时需要，使用方不需要知道
target_compile_definitions(units PRIVATE UNITS_BUILDING=1)
```

判断标准很直接：**公开头文件 `#include` 了某个头，这个路径就是 PUBLIC；只出现在 `.cpp` 里，就是 PRIVATE**。判断错了，使用方要么编译失败（该 PUBLIC 写成 PRIVATE），要么被迫包含无关路径（该 PRIVATE 写成 PUBLIC）。

`$<BUILD_INTERFACE:...>` 和 `$<INSTALL_INTERFACE:...>` 是生成器表达式：构建树里用绝对路径，安装后换成相对安装前缀的路径。安装导出的库必须这样写，否则使用方会看到构建机器上的绝对路径。

### 3.3 别名与命名空间

```cmake
add_library(units src/convert.cpp)
add_library(Units::units ALIAS units)     # 别名，只能被链接，不能被修改
```

别名不产生新 target，只提供第二个名字。约定用 `Namespace::name` 形式，好处是使用方无法通过 `target_link_libraries` 给依赖加属性，依赖关系保持单向。

> 边界：`ALIAS` 不能 `install`，安装时要导出真实 target，再用 `NAMESPACE Units::` 生成别名。导出目标名与代码里的名字必须一致，否则使用方 `find_package` 后链接失败。

## 四、多目录工程组织

目录结构决定 `CMakeLists.txt` 的层级，层级决定作用域。先定结构，再写脚本。

### 4.1 目录结构与 add_subdirectory

```text
units/
├── CMakeLists.txt
├── cmake/
│   └── unitsConfig.cmake.in
├── include/
│   └── units/
│       └── convert.h
├── src/
│   └── convert.cpp
├── app/
│   └── main.cpp
└── tests/
    ├── CMakeLists.txt
    └── convert_test.cpp
```

```cmake
# 顶层 CMakeLists.txt（节选）
cmake_minimum_required(VERSION 3.31)
project(units VERSION 1.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(units src/convert.cpp)
add_library(Units::units ALIAS units)
target_include_directories(units PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)

add_executable(units_cli app/main.cpp)
target_link_libraries(units_cli PRIVATE Units::units)

enable_testing()
add_subdirectory(tests)
```

```cmake
# tests/CMakeLists.txt
add_executable(convert_test convert_test.cpp)
target_link_libraries(convert_test PRIVATE Units::units)
add_test(NAME convert_test COMMAND convert_test)
```

`add_subdirectory` 进入子目录后，父目录的 target 对子目录可见（子目录继承父作用域变量），反过来不成立。因此顶层先定义库，子目录才能链接。

### 4.2 include 目录的两种布局

`#include "units/convert.h"` 要求头文件放在 `include/units/` 下，`target_include_directories` 指向 `include/`。这种「目录名 = 命名空间」的布局避免了头文件重名冲突。

```cpp
// src/convert.cpp
#include "units/convert.h"   // 从 include/ 根开始找，和外部使用方完全一致

namespace units {
double km_to_miles(double km) { return km * 0.621371; }
int celsius_to_fahrenheit(int c) { return c * 9 / 5 + 32; }
}
```

不推荐把头文件直接平铺在 `include/` 下再引用 `"convert.h"`：一旦两个库都有 `convert.h`，使用方只能靠包含顺序碰运气。

### 4.3 目标名、输出名与安装名

```cmake
add_library(units src/convert.cpp)
set_target_properties(units PROPERTIES
    OUTPUT_NAME units          # 产物文件名，默认等于 target 名
    VERSION ${PROJECT_VERSION} # 生成 libunits.so.1.2.0
    SOVERSION 1)               # 兼容版本，决定 soname
```

`VERSION`/`SOVERSION` 只对 `SHARED` 库有意义。`SOVERSION` 变化表示 ABI 不兼容，动态库使用方必须重新编译，这是发布共享库时最容易忽略的一行。

> 边界：target 名全局唯一，不同子目录不能重名；需要同名时用 `add_subdirectory` 前重命名，或把目录拆成独立项目。`OUTPUT_NAME` 可以重名，但同一输出目录下会互相覆盖。

## 五、编译标准、选项与构建类型

编译选项决定「用哪个标准、开哪些警告、优化到什么程度」，三者都应该挂在 target 上，而不是全局字符串拼接。

### 5.1 设置 C++ 标准

两种写法：

```cmake
# 写法一：全局默认值，简单，但无法表达差异
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 写法二：按 target 要求，推荐给库使用
target_compile_features(units PUBLIC cxx_std_20)
```

`target_compile_features` 写的是「至少需要 C++20」，CMake 会换算成 `-std=c++20` 或 `/std:c++20`，并根据使用方要求取最大值。跨平台项目优先用写法二。

### 5.2 警告与优化选项

```cmake
add_library(units src/convert.cpp)

if(MSVC)
    target_compile_options(units PRIVATE /W4 /permissive-)
else()
    target_compile_options(units PRIVATE -Wall -Wextra -Wpedantic)
endif()
```

编译选项必须带作用域：`PRIVATE` 表示只影响本 target，不污染使用方。如果把 `-Wall` 写成 `PUBLIC`，使用方会被迫接收自己没要求的警告等级。

> 边界：`CMAKE_CXX_FLAGS` 是全局字符串，追加时容易重复、顺序错乱，且无法按配置区分。只在必须影响所有 target 时使用（例如统一的 `-fPIC`），其余场景一律用 `target_compile_options`。

### 5.3 生成器表达式

生成器表达式在生成阶段求值，可以按配置、按平台、按 target 类型给不同选项。

```cmake
target_compile_options(units PRIVATE
    "$<$<CONFIG:Debug>:-O0;-g3>"          # 引号不能省：分号会拆成两个参数，破坏表达式
    "$<$<CONFIG:Release>:-O3;-DNDEBUG>")
```

常用表达式：

| 表达式 | 含义 |
|---|---|
| `$<CONFIG:Debug>` | 当前配置是 Debug 时为 1 |
| `$<PLATFORM_ID:Linux>` | 目标平台是 Linux 时为 1 |
| `$<CXX_COMPILER_ID:GNU>` | 编译器是 GCC 时为 1 |
| `$<BUILD_INTERFACE:...>` | 仅构建树生效 |
| `$<INSTALL_INTERFACE:...>` | 仅安装后生效 |

### 5.4 构建类型与 Presets

`CMAKE_BUILD_TYPE` 只对单配置生成器（Ninja、Makefiles）有效；Visual Studio 是多配置生成器，用 `--config Release` 选择。

| 构建类型 | 优化 | 调试信息 | 典型用途 |
|---|---|---|---|
| `Debug` | `-O0` | `-g` | 开发、断点 |
| `Release` | `-O3 -DNDEBUG` | 无 | 发布 |
| `RelWithDebInfo` | `-O2 -g` | 有 | 线上排障 |
| `MinSizeRel` | `-Os` | 无 | 体积敏感 |

选项多起来之后，把常用组合写进 `CMakePresets.json`，避免每次手敲一长串 `-D`：

```json
{
  "version": 6,
  "configurePresets": [
    {
      "name": "release",
      "binaryDir": "${sourceDir}/build/release",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "Release",
        "CMAKE_EXPORT_COMPILE_COMMANDS": "ON"
      }
    }
  ],
  "buildPresets": [
    { "name": "release", "configurePreset": "release", "jobs": 8 }
  ]
}
```

```bash
cmake --preset release
cmake --build --preset release
```

`CMAKE_EXPORT_COMPILE_COMMANDS=ON` 生成 `compile_commands.json`，clangd、CLion、VS Code 的 C++ 插件靠它做跳转和补全。

> 边界：Presets 文件里的 `binaryDir` 使用 `${sourceDir}` 变量；把 `CMakePresets.json` 放在仓库根目录，不要放构建目录。`version` 字段与 CMake 版本绑定，写高了旧版 CMake 直接拒绝读取。

## 六、第三方依赖

CMake 本身不下载包，它只负责「找到包并链接」。依赖从哪来，有三种主流路线。

### 6.1 find_package 的两种模式

| 模式 | 查找依据 | 典型包 |
|---|---|---|
| Config 模式 | `<Package>Config.cmake` | 现代库、vcpkg、Conan |
| Module 模式 | `Find<Package>.cmake` | 系统库、CMake 自带模块 |

```cmake
find_package(Threads REQUIRED)          # Module 模式，CMake 自带
find_package(units 1.2 CONFIG REQUIRED) # Config 模式，指定最低版本
target_link_libraries(app PRIVATE Units::units Threads::Threads)
```

`REQUIRED` 让找不到包时配置阶段直接失败，而不是留到链接期报一堆未定义符号。版本号写 `1.2` 时，是否能接受 1.3 由包自身的 `ConfigVersion.cmake` 决定（常见策略是 `SameMajorVersion`）。

### 6.2 FetchContent

`FetchContent` 在配置阶段下载源码，用 `add_subdirectory` 的方式并入构建树，适合「依赖没有系统包、版本要求精确」的场景。

```cmake
include(FetchContent)

FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.17.0      # 必须锁 tag 或 commit，不能用 main
    GIT_SHALLOW    TRUE)

set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)  # Windows 下避免 CRT 混用
FetchContent_MakeAvailable(googletest)
```

FetchContent 的代价是每次干净配置都要联网下载，CI 里要配缓存。好处是版本随仓库走，不依赖开发机装了什么。

### 6.3 vcpkg 工具链

vcpkg 用工具链文件接管 `find_package`，把依赖装到独立目录，避免污染系统。

```bash
git clone https://github.com/microsoft/vcpkg.git
./vcpkg/bootstrap-vcpkg.sh          # Windows: .\bootstrap-vcpkg.bat

cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE=$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake
```

清单模式（manifest）把依赖写进 `vcpkg.json`，版本随仓库锁定：

```json
{
  "name": "units",
  "version": "1.2.0",
  "dependencies": ["fmt", "gtest"]
}
```

```bash
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE=$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

预期输出（首次会下载并编译依赖，耗时较长）：

```text
-- Running vcpkg install
-- Building fmt:x64-linux-dynamic...
-- Installing: .../vcpkg_installed/x64-linux/share/fmt/fmtConfig.cmake
-- Configuring done
```

> 边界：`CMAKE_TOOLCHAIN_FILE` 必须在**首次配置**时传入；已有缓存时再传不生效，必须先删 `build/`。工具链文件只影响 CMake 查找，不会把 DLL 自动复制到可执行文件旁边，Windows 部署要单独处理。

## 七、安装与导出

安装的目标不是「把文件拷到某个目录」，而是让其他项目能用 `find_package` 找到并正确链接。

### 7.1 install(TARGETS) 与目录变量

```cmake
include(GNUInstallDirs)   # 提供 CMAKE_INSTALL_LIBDIR 等标准变量

install(TARGETS units units_cli
        EXPORT unitsTargets
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}    # Windows 的 .dll、可执行文件
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}    # Unix 的 .so
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}    # 静态库 .a / .lib
        INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
```

三类产物分开写：`RUNTIME` 管可执行文件和 Windows DLL，`LIBRARY` 管 Unix 共享库，`ARCHIVE` 管静态库和导入库。只写一个 `DESTINATION` 在跨平台时会放错位置。

### 7.2 导出 target 与 Config 文件

```cmake
include(CMakePackageConfigHelpers)

install(EXPORT unitsTargets
        FILE unitsTargets.cmake
        NAMESPACE Units::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)

configure_package_config_file(
    cmake/unitsConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion)

install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)
```

```cmake
# cmake/unitsConfig.cmake.in
@PACKAGE_INIT@
include("${CMAKE_CURRENT_LIST_DIR}/unitsTargets.cmake")
check_required_components(units)
```

`@PACKAGE_INIT@` 会展开成一组路径处理宏，让 Config 文件可以被移动位置后仍然工作。`unitsTargets.cmake` 由 `install(EXPORT)` 生成，里面是导入目标 `Units::units` 及其属性。

### 7.3 消费方验证

安装到临时前缀，再用独立工程消费：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PWD/stage
cmake --build build -j 8
cmake --install build
```

```text
-- Installing: .../stage/lib/libunits.a
-- Installing: .../stage/include/units/convert.h
-- Installing: .../stage/lib/cmake/units/unitsConfig.cmake
-- Installing: .../stage/lib/cmake/units/unitsTargets.cmake
```

```cmake
# consumer/CMakeLists.txt
cmake_minimum_required(VERSION 3.31)
project(weather LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)

find_package(units 1.2 CONFIG REQUIRED)
add_executable(weather main.cpp)
target_link_libraries(weather PRIVATE Units::units)
```

```bash
cmake -S consumer -B consumer/build -DCMAKE_PREFIX_PATH=$PWD/stage
cmake --build consumer/build
./consumer/build/weather
```

预期输出：

```text
21.0 km = 13.0488 miles
```

> 边界：`CMAKE_PREFIX_PATH` 指向安装前缀，不是 `lib/cmake/units` 目录。找不到包时先用 `cmake --debug-find` 看搜索路径顺序，不要靠猜。

## 八、测试与打包

CMake 自带 CTest 驱动，测试目标可以是任意可执行文件，不绑定测试框架。

### 8.1 enable_testing 与 add_test

```cmake
enable_testing()                 # 在顶层启用，否则 ctest 找不到测试
add_subdirectory(tests)
```

```cmake
# tests/CMakeLists.txt
add_executable(convert_test convert_test.cpp)
target_link_libraries(convert_test PRIVATE Units::units)
add_test(NAME convert_test COMMAND convert_test)
```

```cpp
// tests/convert_test.cpp
#include "units/convert.h"
#include <cassert>
#include <cmath>
#include <iostream>

int main() {
    assert(std::abs(units::km_to_miles(1.0) - 0.621371) < 1e-9);
    assert(units::celsius_to_fahrenheit(100) == 212);
    assert(units::celsius_to_fahrenheit(0) == 32);
    std::cout << "all tests passed\n";
}
```

```bash
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

预期输出：

```text
    Start 1: convert_test
1/1 Test #1: convert_test .....................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 1
```

### 8.2 测试属性

```cmake
add_test(NAME convert_slow COMMAND convert_slow)
set_tests_properties(convert_slow PROPERTIES
    TIMEOUT 30                 # 超时秒数，防止 CI 卡死
    LABELS "unit"              # ctest -L unit 只跑这一组
    ENVIRONMENT "LOG_LEVEL=error")
```

| 属性 | 作用 |
|---|---|
| `TIMEOUT` | 单测试超时 |
| `LABELS` | 分组，`ctest -L` 过滤 |
| `ENVIRONMENT` | 注入环境变量 |
| `PASS_REGULAR_EXPRESSION` | 输出匹配才算通过 |
| `WILL_FAIL` | 预期失败 |

### 8.3 打包

`CPack` 在安装规则之上生成压缩包或安装包：

```cmake
set(CPACK_PACKAGE_NAME "units")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_GENERATOR "TGZ;DEB")
include(CPack)
```

```bash
cd build
cpack -G TGZ
```

生成的文件名由 `CPACK_PACKAGE_FILE_NAME` 决定，默认包含系统架构。CPack 依赖 `install` 规则，没有写 `install(TARGETS)` 就打不出可用的包。

> 边界：`enable_testing()` 必须在包含测试的目录的祖先作用域里调用；只在 `tests/` 里调用，顶层 `ctest` 会报告「No tests were found」。

## 九、排障

CMake 的问题几乎都能归到三类：缓存脏、路径错、ABI 不匹配。按顺序排查比重新拷一份工程快。

### 9.1 缓存与旧配置

现象：改了 `CMakeLists.txt` 但行为不变，或报 `CMakeCache.txt` 里的旧路径不存在。

```text
CMake Error: The current CMakeCache.txt directory ... is different than the directory ... where CMakeCache.txt was created.
```

原因：`build/` 被整体移动，或从别的机器拷过来。处理：删除构建目录重新配置。

```bash
rm -rf build && cmake -S . -B build
```

### 9.2 链接错误

| 现象 | 原因 | 第一条命令 |
|---|---|---|
| `undefined reference to ...` | 没链接库或链接顺序错 | `cmake --build build --verbose` 看链接行 |
| `cannot find -lfoo` | 库路径未加入 | `find / -name 'libfoo*' 2>/dev/null` |
| 符号重复定义 | 同一实现被编进多个 target | `nm -C libfoo.a \| grep 符号名` |
| 头文件找不到 | include 目录写成 PRIVATE | `cmake --build build --verbose` 看 `-I` |

用 `--verbose` 看真实命令行，是最快的定位方式。CMake 的抽象层在报错时不会给出最终拼出的参数。

### 9.3 ABI 与运行期库

Linux 上编译通过、运行报 `version 'GLIBCXX_3.4.32' not found`，说明构建机 GCC 比运行机新。Windows 上运行报缺少 `MSVCP140.dll`，说明运行库没随程序分发。

```bash
ldd ./app                     # 看依赖的动态库
objdump -T ./app | grep GLIBCXX   # 看需要的符号版本
```

处理方式：在最低支持版本的系统上构建，或用静态链接 `-static-libstdc++ -static-libgcc`（会增加体积，且影响异常跨库传播）。

> 边界：`-static-libstdc++` 只解决标准库，libc 仍然动态链接。完全静态的 glibc 程序在 NSS、dlopen 场景下会出问题，发布前必须在目标系统实测。

## 十、最佳实践案例

### 10.1 案例背景

一个内部工具项目最初是一个目录、一个 `main.cpp`、一段手写的 `g++ *.cpp -o app` 脚本。功能增长到 6000 行后出现三个问题：编译要全量重来；其他团队想复用其中的单位换算逻辑，只能复制源码；CI 里跑测试靠 shell 脚本，失败信息零散。

目标：拆成库 + 命令行 + 测试三部分，支持增量构建、安装导出，让其他项目用 `find_package(units)` 直接引用。

约束：不能改动业务函数签名；三个平台都要能构建；不引入除 CMake 之外的新工具。

### 10.2 案例实操

第一步，建立目录结构，把换算逻辑从 `main.cpp` 拆出来：

```text
units/
├── CMakeLists.txt
├── cmake/unitsConfig.cmake.in
├── include/units/convert.h
├── src/convert.cpp
├── app/main.cpp
└── tests/
    ├── CMakeLists.txt
    └── convert_test.cpp
```

```cpp
// include/units/convert.h
#pragma once

namespace units {
double km_to_miles(double km);
int celsius_to_fahrenheit(int c);
}
```

```cpp
// src/convert.cpp
#include "units/convert.h"

namespace units {
double km_to_miles(double km) { return km * 0.621371; }
int celsius_to_fahrenheit(int c) { return c * 9 / 5 + 32; }
}
```

```cpp
// app/main.cpp
#include "units/convert.h"
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
    double km = argc > 1 ? std::atof(argv[1]) : 10.0;
    std::cout << km << " km = " << units::km_to_miles(km) << " miles\n";
    std::cout << "100C = " << units::celsius_to_fahrenheit(100) << "F\n";
}
```

第二步，顶层 `CMakeLists.txt` 声明库、可执行文件、安装与导出：

```cmake
cmake_minimum_required(VERSION 3.31)
project(units VERSION 1.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(units src/convert.cpp)
add_library(Units::units ALIAS units)

target_include_directories(units PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
target_compile_features(units PUBLIC cxx_std_20)

if(MSVC)
    target_compile_options(units PRIVATE /W4 /permissive-)
else()
    target_compile_options(units PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(units_cli app/main.cpp)
target_link_libraries(units_cli PRIVATE Units::units)

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

install(TARGETS units units_cli
        EXPORT unitsTargets
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(EXPORT unitsTargets
        FILE unitsTargets.cmake
        NAMESPACE Units::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)

configure_package_config_file(
    cmake/unitsConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)
write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion)
install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/unitsConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/units)

enable_testing()
add_subdirectory(tests)
```

```cmake
# cmake/unitsConfig.cmake.in
@PACKAGE_INIT@
include("${CMAKE_CURRENT_LIST_DIR}/unitsTargets.cmake")
check_required_components(units)
```

第三步，注册测试：

```cmake
# tests/CMakeLists.txt
add_executable(convert_test convert_test.cpp)
target_link_libraries(convert_test PRIVATE Units::units)
add_test(NAME convert_test COMMAND convert_test)
```

```cpp
// tests/convert_test.cpp
#include "units/convert.h"
#include <cassert>
#include <cmath>
#include <iostream>

int main() {
    assert(std::abs(units::km_to_miles(1.0) - 0.621371) < 1e-9);
    assert(units::celsius_to_fahrenheit(100) == 212);
    assert(units::celsius_to_fahrenheit(0) == 32);
    std::cout << "all tests passed\n";
}
```

第四步，配置、构建、测试、安装：

```bash
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PWD/stage
cmake --build build -j 8
ctest --test-dir build --output-on-failure
cmake --install build
./stage/bin/units_cli 5
```

预期输出：

```text
[4/4] Linking CXX executable units_cli
    Start 1: convert_test
1/1 Test #1: convert_test .....................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 1
-- Installing: .../stage/lib/cmake/units/unitsConfig.cmake
5 km = 3.10685 miles
100C = 212F
```

第五步，另建一个工程验证导出结果：

```cmake
# consumer/CMakeLists.txt
cmake_minimum_required(VERSION 3.31)
project(weather LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(units 1.2 CONFIG REQUIRED)
add_executable(weather main.cpp)
target_link_libraries(weather PRIVATE Units::units)
```

```cpp
// consumer/main.cpp
#include "units/convert.h"
#include <iostream>

int main() {
    std::cout << "21.0 km = " << units::km_to_miles(21.0) << " miles\n";
}
```

```bash
cmake -S consumer -B consumer/build -DCMAKE_PREFIX_PATH=$PWD/stage
cmake --build consumer/build
./consumer/build/weather
```

预期输出：

```text
21.0 km = 13.0488 miles
```

### 10.3 案例结果

改造后的收益可以直接量化（示例，单机 8 核）：

- 增量构建：改一个 `.cpp` 只重编该文件并重链接，耗时从全量 12 s 降到 1.1 s；
- 复用：外部工程引入只需两行 CMake 和一个 `find_package` 版本约束，不再复制源码；
- CI：`ctest` 退出码直接反映结果，失败时 `--output-on-failure` 给出断言位置，脚本从 40 行缩到 3 行。

失败模式与复盘：

- 最初把 `target_include_directories` 写成 `PRIVATE`，安装后使用方找不到 `units/convert.h`。公开头文件的路径必须是 `PUBLIC`，并用 `INSTALL_INTERFACE` 指向安装后的相对路径。
- 忘记 `@PACKAGE_INIT@`，Config 文件在使用方被移动后路径失效。模板文件不能省这一行。
- 在已有 `build/` 上换 `CMAKE_INSTALL_PREFIX` 不生效，因为安装前缀进了缓存。改前缀要重新配置或显式 `-D` 覆盖。
- `assert` 在 `Release` 下被 `-DNDEBUG` 关掉，测试变成空跑。真实项目应改用 GoogleTest 或 Catch2（见下一篇），或者在测试 target 上单独 `target_compile_options(convert_test PRIVATE -UNDEBUG)`。
