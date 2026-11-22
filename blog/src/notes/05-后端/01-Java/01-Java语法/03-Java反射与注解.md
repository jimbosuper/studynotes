---
title: "Java反射与注解"
category: "05-后端"
---

# Java反射与注解

> 这篇从 `Class` 对象和反射调用讲起，经过字段与方法访问、动态代理、注解定义与运行时读取、编译期注解处理，最后落到一个注解驱动的重试代理和它的排障方法。
>
> 学完能读懂框架里的反射入口，自己定义并读取运行时注解，用动态代理抽掉重复逻辑，并判断什么时候不该用反射。

## 一、反射的边界与 Class 对象

这章解决“运行时如何拿到类型信息，以及哪些场景值得拿”。

### 1.1 反射的适用边界

反射是在运行时检查类、创建对象、读写字段、调用方法的能力。它解决的是“编译期不知道具体类型，运行时才拿到类名或配置”的问题。

框架是反射的主要使用者：Spring 用反射创建 Bean 并注入依赖，Jackson 用反射读写属性，MyBatis 用反射把结果集映射成对象，JUnit 用反射发现测试方法。业务代码直接写反射，通常意味着类型设计或扩展点设计有问题。

边界：反射调用没有编译期类型检查，参数写错只在运行时失败；它绕开访问控制，破坏封装；调用点难以被 IDE 追踪。规则是“框架和基础设施用反射，业务主流程用强类型 API”。

### 1.2 获取 Class 对象

运行时每个类型只有一个 `Class` 实例，它是反射的入口。

```java
Class<String> a = String.class;                 // 编译期已知类型，不触发初始化
Class<?> b = "java".getClass();                 // 从实例拿运行时类型
Class<?> c = Class.forName("java.lang.String"); // 从类名加载，默认触发初始化
Class<?> d = int.class;                         // 基本类型也有 Class 对象
```

| 方式 | 触发类初始化 | 典型场景 |
|---|---|---|
| `Type.class` | 否 | 已知类型、注解属性 |
| `obj.getClass()` | 否 | 运行时多态 |
| `Class.forName(name)` | 是 | 配置驱动、JDBC 驱动 |
| `loader.loadClass(name)` | 否 | 自定义类加载器 |

`Class.forName` 还有重载 `forName(name, false, loader)`，第二个参数传 `false` 可以只加载不初始化。类初始化会执行静态块和静态字段赋值，时机敏感时要用这个重载。

### 1.3 Class 提供的元数据

`Class` 把类的结构暴露成可查询对象：字段、方法、构造器、父类、接口、记录组件、密封子类型。

```java
record UserDto(long id, String name) {}

static void inspect(Class<?> type) {
    System.out.println("name=" + type.getSimpleName());
    System.out.println("record=" + type.isRecord());
    System.out.println("sealed=" + type.isSealed());
    System.out.println("super=" + (type.getSuperclass() == null
        ? "-" : type.getSuperclass().getSimpleName()));
    for (var field : type.getDeclaredFields()) {
        System.out.println("field=" + field.getName()
            + ":" + field.getType().getSimpleName());
    }
    java.util.Arrays.stream(type.getDeclaredMethods())
        .map(java.lang.reflect.Method::getName)
        .sorted()                              // 方法顺序由编译器决定，排序后输出稳定
        .forEach(name -> System.out.println("method=" + name));
}

inspect(UserDto.class);
```

```text
name=UserDto
record=true
sealed=false
super=Record
field=id:long
field=name:String
method=equals
method=hashCode
method=id
method=name
method=toString
```

`getDeclaredXxx` 只返回当前类声明的成员，`getXxx` 还包含继承的 public 成员；构造器只能用 `getDeclaredConstructor`，因为构造器不被继承。

### 1.4 类初始化的时机

`Class.forName` 默认执行静态初始化，`.class` 和 `getClass()` 不会。这个差异决定了静态块里的连接池、配置加载在什么时候发生。

```java
public class LoadDemo {
    static class Config {
        static { System.out.println("Config 静态块"); }
        static String value = "loaded";
    }

    public static void main(String[] args) throws Exception {
        System.out.println("before .class");
        Class<?> a = Config.class;
        System.out.println("after .class: " + a.getSimpleName());

        System.out.println("before forName");
        Class<?> b = Class.forName("LoadDemo$Config");
        System.out.println("after forName: " + b.getSimpleName());
    }
}
```

```text
before .class
after .class: Config
before forName
Config 静态块
after forName: Config
```

边界：静态块里做阻塞 IO 或依赖外部配置，会让“加载类”变成“启动服务”；把这类逻辑移到显式的初始化方法，反射只负责发现类型。

版本基线（2026-11-13）：Java 21 LTS。反射、动态代理、注解 API 在 Java 21 与 25 上保持一致；APT 示例用 JDK 21 的 `javac` 验证，Java 25 同样可用。

## 二、反射读取与调用

这章解决“拿到 `Class` 后，怎样创建对象、读写字段、调用方法”。

### 2.1 创建实例

反射创建对象走 `Constructor`，不再使用已废弃的 `Class.newInstance()`。

```java
Class<?> type = Class.forName("java.util.ArrayList");
List<?> list = (List<?>) type.getDeclaredConstructor().newInstance();
System.out.println(list.getClass().getName()); // java.util.ArrayList
```

无参构造器不是每个类都有。record 的规范构造器参数与组件顺序一致：

```java
record Money(long cents, String currency) {}

var ctor = Money.class.getDeclaredConstructor(long.class, String.class);
Money money = (Money) ctor.newInstance(9900L, "CNY");
System.out.println(money); // Money[cents=9900, currency=CNY]
```

私有构造器需要 `setAccessible(true)`。边界：单例类、工具类的私有构造器被反射打开后，单例约束就失效了，框架代码要避免这种“万能创建”。

### 2.2 字段读写

字段读取用 `Field.get`，写入用 `Field.set`；私有字段先 `setAccessible(true)`。静态字段的目标对象传 `null`。

```java
class Config {
    private int port = 8080;
    private static String env = "dev";
}

Config config = new Config();
Field port = Config.class.getDeclaredField("port");
port.setAccessible(true);
System.out.println(port.get(config)); // 8080
port.set(config, 9090);
System.out.println(port.get(config)); // 9090

Field env = Config.class.getDeclaredField("env");
System.out.println(env.get(null));    // dev，静态字段不需要实例
```

边界：`final` 字段不要用反射修改。编译器可能已经把常量内联，JIT 也可能假设它不变，写入结果不可预测；需要可变配置就用普通字段或配置中心。

### 2.3 方法调用

`Method.invoke` 的第一个参数是目标对象，后面按声明顺序传参；静态方法的目标对象传 `null`。

```java
Method substring = String.class.getMethod("substring", int.class, int.class);
Object result = substring.invoke("reflection", 0, 4);
System.out.println(result); // refl
```

`getMethod` 找 public 方法并包含继承方法，`getDeclaredMethod` 只找当前类声明的方法。重载方法必须传精确的参数类型，`getMethod("foo", null)` 表示无参，不是“任意参数”。

被调用方法抛出的异常会被包在 `InvocationTargetException` 里，必须拆出 `getCause()`，否则日志里看到的只是反射层异常。

```java
try {
    method.invoke(target, args);
} catch (InvocationTargetException e) {
    throw e.getCause(); // 保留业务异常类型和栈
}
```

边界：可变参数方法在反射里是一个数组参数。调用 `String.format(String, Object...)` 时，要把参数整体包成 `new Object[]{format, values}`，否则会被当成多个参数。

### 2.4 泛型信息与数组

泛型在运行时擦除，但字段、方法签名、父接口上的泛型信息保留在字节码签名里，可以通过 `getGenericType` 读取。

```java
class Dao<T> {
    List<T> findAll() { return List.of(); }
}

Method method = Dao.class.getDeclaredMethod("findAll");
System.out.println(method.getGenericReturnType()); // java.util.List<T>
```

需要创建数组时用 `Array.newInstance`，它在运行时才知道组件类型：

```java
Object array = Array.newInstance(String.class, 3);
Array.set(array, 0, "a");
System.out.println(Array.getLength(array)); // 3
```

边界：`getGenericReturnType()` 返回的是 `Type`，要判断是否为 `ParameterizedType` 再取 `getActualTypeArguments()`；直接强转会在非泛型签名上抛 `ClassCastException`。

### 2.5 可访问性与模块边界

`setAccessible(true)` 不是万能钥匙。JDK 9 之后，`java.base` 的内部包默认不向未命名模块开放，强行访问会抛 `InaccessibleObjectException`。

```java
Field value = String.class.getDeclaredField("value");
value.setAccessible(true); // JDK 21 抛 InaccessibleObjectException
```

```text
Exception in thread "main" java.lang.reflect.InaccessibleObjectException:
Unable to make field private final byte[] java.lang.String.value accessible:
module java.base does not "opens java.lang" to unnamed module
```

临时排查可以加启动参数，但生产环境不应靠它改 JDK 内部结构：

```bash
java --add-opens java.base/java.lang=ALL-UNNAMED Main
```

模块化项目在 `module-info.java` 里精确开放包：

```java
module com.example.app {
    opens com.example.model to com.fasterxml.jackson.databind;
}
```

边界：`opens` 只对反射访问生效，不等于 `exports`；开放整个包会让所有反射框架都能读写，范围要按框架需要收窄。

## 三、动态代理

这章解决“怎样在调用前后统一加逻辑，而不改实现类”。

### 3.1 JDK 动态代理的约束

JDK 动态代理在运行时生成一个实现指定接口的类，把所有方法调用转给 `InvocationHandler`。它只能代理接口，不能代理普通类；目标类必须能被同一个类加载器看到。

```java
Object proxy = Proxy.newProxyInstance(
    type.getClassLoader(),
    new Class<?>[]{type},
    (p, method, args) -> method.invoke(target, args));
```

`Proxy.isProxyClass(proxy.getClass())` 可以判断一个对象是不是动态代理。代理类名形如 `jdk.proxy3.$Proxy0`，序号随生成顺序变化，不能写进业务判断。

### 3.2 日志代理实现

```java
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.Arrays;

public class LoggingProxy {

    interface UserService {
        String find(long id);
        default String ping() { return "pong"; }
    }

    static class UserServiceImpl implements UserService {
        @Override
        public String find(long id) { return "user-" + id; }
    }

    @SuppressWarnings("unchecked")
    static <T> T wrap(Class<T> type, T target) {
        return (T) Proxy.newProxyInstance(
            type.getClassLoader(),
            new Class<?>[]{type},
            (proxy, method, args) -> {
                // Object 方法也会进 handler，必须自己处理，否则 equals 行为会失真
                if (method.getDeclaringClass() == Object.class) {
                    return switch (method.getName()) {
                        case "toString" -> "proxy(" + target.getClass().getSimpleName() + ")";
                        case "hashCode" -> System.identityHashCode(proxy);
                        case "equals" -> proxy == args[0];
                        default -> throw new UnsupportedOperationException(method.getName());
                    };
                }
                System.out.println("调用 " + method.getName()
                    + (args == null ? "[]" : Arrays.toString(args)));
                try {
                    return method.invoke(target, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause(); // 把业务异常原样抛给调用方
                }
            });
    }

    public static void main(String[] args) {
        UserService service = wrap(UserService.class, new UserServiceImpl());
        System.out.println(service.find(7));
        System.out.println(service.ping());
        System.out.println(service);
    }
}
```

```bash
javac -encoding UTF-8 LoggingProxy.java
java LoggingProxy
```

```text
调用 find[7]
user-7
调用 ping[]
pong
proxy(UserServiceImpl)
```

### 3.3 InvocationHandler 的坑

- 代理对象调用 `toString`、`equals`、`hashCode` 也会进入 handler，不处理会得到 `$Proxy0@...` 或错误的相等判断；
- 目标方法抛的受检异常如果不在接口声明里，代理层会包成 `UndeclaredThrowableException`；
- 在 handler 里再调用同一个代理对象的方法会递归，直到栈溢出；
- 默认方法可以直接 `method.invoke(target, args)`，目标实现类会执行接口默认实现；需要在 handler 内单独调用时用 `InvocationHandler.invokeDefault`。

### 3.4 JDK 代理与 CGLIB

| 维度 | JDK 动态代理 | CGLIB |
|---|---|---|
| 代理目标 | 接口 | 类 |
| 实现方式 | 生成接口实现类 | 生成子类 |
| 限制 | 无接口不能用 | final 类/方法不能代理 |
| 依赖 | JDK 自带 | 第三方字节码库 |

Spring AOP 对接口优先用 JDK 代理，对类用 CGLIB；Spring Boot 默认更倾向 CGLIB，避免“必须抽接口”的限制。选择依据是目标类型和团队约定，不是性能神话。

## 四、注解定义与元注解

这章解决“怎样把配置元数据写进代码，并控制它何时可见”。

### 4.1 注解是接口

注解编译后是一个继承 `java.lang.annotation.Annotation` 的接口，元素是无形参、无异常的方法。注解本身不执行任何逻辑，行为来自读取它的反射代码、注解处理器或框架拦截器。

| 元注解 | 用途 | 默认值 |
|---|---|---|
| `@Retention` | 保留到哪个阶段 | `CLASS` |
| `@Target` | 可标注的位置 | 不限 |
| `@Inherited` | 类注解是否被子类继承 | 否 |
| `@Documented` | 是否进入 Javadoc | 否 |
| `@Repeatable` | 是否可重复标注 | 否 |

`RetentionPolicy.SOURCE` 只给编译器看，`CLASS` 进入字节码但反射读不到，`RUNTIME` 才能通过 `getAnnotation` 读取。注解默认是 `CLASS`，忘记写 `RUNTIME` 是“注解加了但不生效”的第一原因。

### 4.2 定义业务注解

```java
import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
@Documented
public @interface Retry {
    int maxAttempts() default 3;
    long backoffMillis() default 100;
}
```

元素类型只能是基本类型、`String`、`Class`、枚举、另一个注解或它们的数组；默认值必须是编译期常量，不能是 `null`。需要“未配置”语义时用特殊值（如 `-1`、空字符串）或 `Optional` 包装，不要返回 null。

### 4.3 组合注解

组合注解把多个注解打包成一个，Spring 的 `@SpringBootApplication` 就是 `@SpringBootConfiguration`、`@EnableAutoConfiguration`、`@ComponentScan` 的组合。

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@SpringBootApplication
public @interface WebApplication {
    String name() default "web";
}
```

边界：普通 `getAnnotation(SpringBootApplication.class)` 只读直接标注的注解，读不到组合注解里的元注解；Spring 用 `MergedAnnotations` 或 `AnnotationUtils` 做递归查找，自己写框架时也要补这一层。

### 4.4 注解不能做什么

注解不能自己执行、不能改运行时状态、不能存请求级数据、不能代替配置中心。它适合声明“这个方法是幂等的”“这个字段需要校验”“这个类是一个组件”，把变化频率低、编译期可确定的元数据放在代码旁。

## 五、运行时读取注解

这章解决“注解写完后，程序怎样在启动或调用时读到它”。

### 5.1 读取 API

`getAnnotation` 返回指定类型的注解或 `null`；`getDeclaredAnnotation` 只读当前元素直接标注的注解；`getAnnotationsByType` 支持重复注解；`isAnnotationPresent` 只判断存在性。

类注解只有在标注 `@Inherited` 时才从父类继承，方法注解不会被继承。`getAnnotations()` 还会包含 `@Retention(RUNTIME)` 的元注解，遍历时要按类型过滤。

### 5.2 字段校验器

```java
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;

public class ValidateDemo {

    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.FIELD)
    @interface NotBlank {
        String message() default "不能为空";
    }

    static class UserForm {
        @NotBlank
        String name;

        @NotBlank(message = "邮箱不能为空")
        String email;

        String note;

        UserForm(String name, String email) {
            this.name = name;
            this.email = email;
        }
    }

    static List<String> validate(Object form) throws IllegalAccessException {
        List<String> errors = new ArrayList<>();
        for (Field field : form.getClass().getDeclaredFields()) {
            NotBlank rule = field.getAnnotation(NotBlank.class);
            if (rule == null) continue;       // 没标注的字段直接跳过
            field.setAccessible(true);        // 私有字段需要打开访问
            Object value = field.get(form);
            if (value == null || value.toString().isBlank()) {
                errors.add(field.getName() + ": " + rule.message());
            }
        }
        return errors;
    }

    public static void main(String[] args) throws Exception {
        System.out.println(validate(new UserForm("张三", " ")));
        System.out.println(validate(new UserForm("张三", "a@b.com")));
    }
}
```

```text
[email: 邮箱不能为空]
[]
```

边界：这个校验器只处理字段，不处理继承字段、嵌套对象和分组校验；生产项目用 Jakarta Bean Validation（Hibernate Validator），不要重复造轮子。

### 5.3 重复注解

同一位置需要多个同类型注解时，用 `@Repeatable` 指定容器注解：

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@Repeatable(Roles.class)
@interface Role { String value(); }

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@interface Roles { Role[] value(); }

@Role("admin")
@Role("auditor")
class AdminService {}

Role[] roles = AdminService.class.getAnnotationsByType(Role.class);
System.out.println(roles.length); // 2
```

容器注解的 `@Retention` 和 `@Target` 不能比被包含的注解更宽松；否则编译器直接报错。

### 5.4 注解与动态配置的边界

注解元素必须是编译期常量，不能写 `@Retry(maxAttempts = config.getRetry())`。需要按环境变化的值放配置中心或数据库，注解只保留稳定的默认值。两者冲突时，明确优先级，例如“注解显式值 > 配置文件 > 代码默认值”，并在启动日志里打印最终生效值。

## 六、编译期注解处理

这章解决“怎样在编译时检查或生成代码，避免运行时反射开销”。

### 6.1 APT 与反射的分工

| 维度 | 运行时反射 | 编译期注解处理 |
|---|---|---|
| 时机 | 程序运行中 | `javac` 编译中 |
| 输入 | 已加载的类 | 源码元素 |
| 输出 | 调用结果、代理对象 | 新源码、编译错误 |
| 开销 | 每次查找与调用 | 只发生在构建期 |
| 典型 | Spring、Jackson | Lombok、MapStruct |

能在编译期确定的检查，不要拖到运行时。`@Retry(maxAttempts = 0)` 这种错误，注解处理器可以直接让构建失败。

### 6.2 处理器骨架

```java
import java.util.Set;
import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.annotation.processing.SupportedSourceVersion;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;

@SupportedAnnotationTypes("Retry")
@SupportedSourceVersion(SourceVersion.RELEASE_21)
public class RetryProcessor extends AbstractProcessor {

    @Override
    public boolean process(Set<? extends TypeElement> annotations,
                           RoundEnvironment roundEnv) {
        for (Element element : roundEnv.getElementsAnnotatedWith(Retry.class)) {
            Retry retry = element.getAnnotation(Retry.class);
            if (retry.maxAttempts() < 1) {
                // 编译期报错，定位到具体方法，不生成 class 文件
                processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.ERROR, "@Retry.maxAttempts 必须 >= 1", element);
            }
        }
        return true; // 声明该处理器消费了这些注解
    }
}
```

`@SupportedAnnotationTypes` 也可以用 `getSupportedAnnotationTypes()` 方法返回；`process` 每轮调用一次，`roundEnv.processingOver()` 为 true 表示最后一轮。生成源码用 `processingEnv.getFiler().createSourceFile(...)`，生成资源用 `createResource(...)`。

### 6.3 编译与验证

先编译注解和处理器，再用处理器编译业务代码：

```bash
javac -encoding UTF-8 -d proc-classes Retry.java RetryProcessor.java
javac -encoding UTF-8 -cp proc-classes -processor RetryProcessor -d out BadRetry.java
```

`BadRetry.java` 里写 `@Retry(maxAttempts = 0)`，预期编译失败：

```text
BadRetry.java:4: 错误: @Retry.maxAttempts 必须 >= 1
        String call();
               ^
1 个错误
```

JDK 是英文环境时输出 `error:`，结构与退出码一致。构建脚本要检查 `javac` 的退出码，不能只看最后一行。

### 6.4 注册与构建集成

处理器要能被 `javac` 发现，标准做法是写服务文件：

```text
META-INF/services/javax.annotation.processing.Processor
```

内容为处理器全限定名，一行一个：

```text
com.example.retry.RetryProcessor
```

Maven 项目显式声明处理器路径，避免把处理器混进运行时依赖：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <version>3.14.0</version>
  <configuration>
    <annotationProcessorPaths>
      <path>
        <groupId>com.example</groupId>
        <artifactId>retry-processor</artifactId>
        <version>1.0.0</version>
      </path>
    </annotationProcessorPaths>
  </configuration>
</plugin>
```

边界：JDK 23 起，未显式声明处理器时不再自动扫描 classpath 上的处理器；构建里写 `annotationProcessorPaths` 是兼容新 JDK 的做法。Gradle 用 `annotationProcessor` 配置，不要把处理器放进 `implementation`。

### 6.5 APT 的能力边界

注解处理器只能生成新文件或报错，不能修改已有源文件；它看到的是源码语法树，不是运行时对象；处理器写得太重会显著拖慢增量构建。Lombok 通过修改编译器内部 AST 实现 getter/setter，属于非标准做法，升级 JDK 时最容易坏，团队要评估维护成本。

## 七、性能、封装与模块边界

这章解决“反射什么时候会成为瓶颈，什么时候会破坏封装”。

### 7.1 缓存查找结果

反射的昂贵部分主要是查找（`getDeclaredMethod`、`getDeclaredField`）和安全检查，`invoke` 本身在 JIT 优化后成本可控。把 `Method`、`Field`、`Constructor` 缓存起来，避免在循环里重复查找。

```java
private static final Map<String, Method> CACHE = new ConcurrentHashMap<>();

static Object invoke(Object target, String name, Object... args) throws Exception {
    String key = target.getClass().getName() + "#" + name;
    Method method = CACHE.computeIfAbsent(key, k -> {
        try {
            return target.getClass().getDeclaredMethod(name);
        } catch (NoSuchMethodException e) {
            throw new IllegalArgumentException("方法不存在: " + k, e);
        }
    });
    method.setAccessible(true);
    return method.invoke(target, args);
}
```

缓存键要包含类名和方法名；重载方法还要包含参数类型，否则同名不同参的方法会互相覆盖。

### 7.2 MethodHandle

`MethodHandle` 是 JDK 7 引入的可执行引用，查找时做类型检查，调用点可被 JIT 内联，通常比反复反射调用更快。

```java
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

MethodHandle handle = MethodHandles.lookup().findVirtual(
    String.class, "substring", MethodType.methodType(String.class, int.class, int.class));
System.out.println((String) handle.invokeExact("reflection", 0, 4)); // refl
```

`invokeExact` 要求参数和返回类型精确匹配，`invoke` 允许自动转换但会慢一些。边界：MethodHandle 的 API 比反射难写，参数类型错误在链接时抛 `WrongMethodTypeException`；只有确认反射是热点后才值得替换。

### 7.3 setAccessible 的代价

`setAccessible(true)` 关闭 Java 语言访问检查，让私有成员可读写。代价是封装被破坏、模块边界被绕过、代码与 JDK 内部实现耦合。JDK 17 起强封装默认开启，访问 `java.base` 内部包会失败；`--add-opens` 是临时手段，不是设计方案。

### 7.4 什么时候不用反射

- 编译期已知类型：直接 `new`、直接调用，IDE 能跳转、编译器能检查；
- 高频交易或序列化热路径：用代码生成、MethodHandle 或专用库；
- GraalVM native image：反射需要额外的 `reflect-config.json`，漏配在运行时报 `ClassNotFoundException`；
- 安全敏感场景：不要反序列化不可信输入，不要用反射绕过权限检查。

## 八、排障与现场手册

这章解决“反射和注解出错时，第一条命令查什么”。

| 现象 | 原因 | 第一条检查 |
|---|---|---|
| `ClassNotFoundException` | 类名拼错或依赖缺失 | `Class.forName` 的全限定名、classpath |
| `NoSuchMethodException` | 参数类型不匹配 | `javap -p` 看真实签名 |
| `IllegalAccessException` | 成员不可访问 | 是否 `setAccessible`、模块是否 opens |
| `InaccessibleObjectException` | 强封装阻止访问 | 是否访问 `java.base` 内部包 |
| `InvocationTargetException` | 被调方法自身抛异常 | 打印 `getCause()` |
| 注解读不到 | `Retention` 不是 RUNTIME | `javap -v` 看 RuntimeVisibleAnnotations |

`javap` 是确认编译结果的最快方式：

```bash
javap -v -p Retry.class
```

```text
public interface Retry extends java.lang.annotation.Annotation
...
RuntimeVisibleAnnotations:
  0: java.lang.annotation.Retention(...)
  1: java.lang.annotation.Target(...)
```

代理类生成时可以落盘检查：

```bash
java -Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true LoggingProxy
ls jdk/proxy1/\$Proxy0.class
```

生成文件按代理类的动态包路径落在 `jdk/proxy1/` 下，序号随代理数量变化；反编译可以看到代理类如何把每个接口方法转给 `InvocationHandler`。

类加载顺序用 `-verbose:class` 或 `-Xlog:class+load=info` 观察；确认某个类是否被初始化，在静态块里打日志比猜快。

现场检查清单：

1. 先确认类名、方法签名、参数类型是否与 `javap` 输出一致；
2. 再确认 `Retention` 和 `Target` 是否覆盖当前读取位置；
3. 私有成员先检查模块是否 `opens`，再考虑 `--add-opens`；
4. 代理异常先拆 `InvocationTargetException`，不要只看最外层；
5. 注解处理器不生效时，检查 `META-INF/services`、`-processor` 参数和构建工具的 processor path。

## 九、最佳实践案例

### 9.1 案例背景

订单服务调用库存服务的 `stock(sku)` 接口，下游偶发 1 到 2 秒的超时，重试两次通常恢复。旧代码在每个调用点写 `for` 循环、`try-catch` 和 `Thread.sleep`，十几个方法重复同一段逻辑，重试次数和退避时间还不一致。目标是把重试声明成注解，调用方只写业务接口；约束是只重试幂等查询、最多三次、退避 50 毫秒，失败后保留原始异常。

### 9.2 案例实操

定义运行时注解：

```java
// Retry.java
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)          // 运行时可读，代理才能拿到配置
@Target(ElementType.METHOD)                  // 只允许标在方法上
public @interface Retry {
    int maxAttempts() default 3;
    long backoffMillis() default 100;
}
```

用动态代理拦截标注了 `@Retry` 的方法：

```java
// RetryDemo.java
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;

public class RetryDemo {

    public interface InventoryClient {
        @Retry(maxAttempts = 3, backoffMillis = 50)
        int stock(String sku);

        String health();
    }

    static class FlakyInventoryClient implements InventoryClient {
        private final AtomicInteger calls = new AtomicInteger();

        @Override
        public int stock(String sku) {
            int attempt = calls.incrementAndGet();
            if (attempt < 3) {
                throw new IllegalStateException("下游超时");
            }
            return 42;
        }

        @Override
        public String health() {
            return "UP";
        }
    }

    @SuppressWarnings("unchecked")
    static <T> T withRetry(Class<T> type, T target) {
        return (T) Proxy.newProxyInstance(
            type.getClassLoader(),
            new Class<?>[]{type},
            (proxy, method, args) -> {
                Retry retry = method.getAnnotation(Retry.class);
                int maxAttempts = retry == null ? 1 : retry.maxAttempts();
                for (int attempt = 1; ; attempt++) {
                    try {
                        Object result = method.invoke(target, args);
                        if (retry != null) {
                            System.out.printf("[proxy] %s 第 %d 次 -> 成功%n",
                                method.getName(), attempt);
                        }
                        return result;
                    } catch (InvocationTargetException e) {
                        Throwable cause = e.getCause();
                        System.out.printf("[proxy] %s 第 %d 次 -> 失败: %s%n",
                            method.getName(), attempt, cause.getMessage());
                        // 只重试已知的瞬时异常，其他异常立即抛出，避免掩盖业务错误
                        if (attempt >= maxAttempts
                            || !(cause instanceof IllegalStateException)) {
                            throw cause;
                        }
                        Thread.sleep(retry.backoffMillis());
                    }
                }
            });
    }

    public static void main(String[] args) {
        InventoryClient client = withRetry(
            InventoryClient.class, new FlakyInventoryClient());
        System.out.println("stock=" + client.stock("SKU-1"));
        System.out.println("health=" + client.health());
        System.out.println("isProxy=" + Proxy.isProxyClass(client.getClass()));
    }
}
```

```bash
javac -encoding UTF-8 Retry.java RetryDemo.java
java RetryDemo
```

预期输出：

```text
[proxy] stock 第 1 次 -> 失败: 下游超时
[proxy] stock 第 2 次 -> 失败: 下游超时
[proxy] stock 第 3 次 -> 成功
stock=42
health=UP
isProxy=true
```

### 9.3 案例结果

重试逻辑从每个调用点收进代理，标注 `@Retry` 的方法自动获得三次尝试；未标注的 `health()` 只调用一次，输出中没有它的重试日志。两次退避各 50 毫秒，总耗时约 100 毫秒，相比手写循环没有增加调用次数。

失败模式需要提前写进规范。第一，非幂等操作不能重试：下单、扣款、发短信重放会造成重复副作用，只对查询或带幂等键的写操作开启。第二，重试必须有总预算：三次 50 毫秒可以接受，三次 2 秒会拖垮上游线程池，生产代码要把单次超时、退避、总超时一起配置。第三，重试风暴：下游整体故障时所有调用方同时重试，会把故障放大，需要加随机抖动、熔断和限流。第四，异常分类：只重试超时、连接重置这类瞬时异常，`IllegalArgumentException` 立即抛出。

复盘：这个代理适合作为理解反射与注解的骨架；生产项目直接用 Resilience4j 或 Spring Retry，它们已经处理了退避策略、指标、熔断和线程安全。自研版本必须补上日志脱敏、异常指标和配置校验，否则只是把重复代码换成了一个不易观测的黑盒。
