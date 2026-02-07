# CQRS+ES知識

## Aggregate設計

Aggregateは判断に必要なフィールドのみ保持する。

Command Model（Aggregate）の役割は「コマンドを受けて判断し、イベントを発行する」こと。クエリ用データはRead Model（Projection）が担当する。

「判断に必要」とは:
- `if`/`require`の条件分岐に使う
- インスタンスメソッドでイベント発行時にフィールド値を参照する

| 基準 | 判定 |
|------|------|
| Aggregateが複数のトランザクション境界を跨ぐ | REJECT |
| Aggregate間の直接参照（ID参照でない） | REJECT |
| Aggregateが100行を超える | 分割を検討 |
| ビジネス不変条件がAggregate外にある | REJECT |
| 判断に使わないフィールドを保持 | REJECT |

良いAggregate:
```kotlin
// 判断に必要なフィールドのみ
data class Order(
    val orderId: String,      // イベント発行時に使用
    val status: OrderStatus   // 状態チェックに使用
) {
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
        return OrderConfirmedEvent(
            orderId = orderId,
            confirmedBy = confirmedBy,
            confirmedAt = LocalDateTime.now()
        )
    }
}

// 判断に使わないフィールドを保持（NG）
data class Order(
    val orderId: String,
    val customerId: String,     // 判断に未使用
    val shippingAddress: Address, // 判断に未使用
    val status: OrderStatus
)
```

追加操作がないAggregateはIDのみ:
```kotlin
// 作成のみで追加操作がない場合
data class Notification(val notificationId: String) {
    companion object {
        fun create(customerId: String, message: String): NotificationCreatedEvent {
            return NotificationCreatedEvent(
                notificationId = UUID.randomUUID().toString(),
                customerId = customerId,
                message = message
            )
        }
    }
}
```

## イベント設計

| 基準 | 判定 |
|------|------|
| イベントが過去形でない（Created → Create） | REJECT |
| イベントにロジックが含まれる | REJECT |
| イベントが他Aggregateの内部状態を含む | REJECT |
| イベントのスキーマがバージョン管理されていない | 警告 |
| CRUDスタイルのイベント（Updated, Deleted） | 要検討 |

良いイベント:
```kotlin
// Good: ドメインの意図が明確
OrderPlaced, PaymentReceived, ItemShipped

// Bad: CRUDスタイル
OrderUpdated, OrderDeleted
```

イベント粒度:
- 細かすぎ: `OrderFieldChanged` → ドメインの意図が不明
- 適切: `ShippingAddressChanged` → 意図が明確
- 粗すぎ: `OrderModified` → 何が変わったか不明

## コマンドハンドラ

| 基準 | 判定 |
|------|------|
| ハンドラがDBを直接操作 | REJECT |
| ハンドラが複数Aggregateを変更 | REJECT |
| コマンドのバリデーションがない | REJECT |
| ハンドラがクエリを実行して判断 | 要検討 |

良いコマンドハンドラ:
```
1. コマンドを受け取る
2. Aggregateをイベントストアから復元
3. Aggregateにコマンドを適用
4. 発行されたイベントを保存
```

## プロジェクション設計

| 基準 | 判定 |
|------|------|
| プロジェクションがコマンドを発行 | REJECT |
| プロジェクションがWriteモデルを参照 | REJECT |
| 複数のユースケースを1つのプロジェクションで賄う | 要検討 |
| リビルド不可能な設計 | REJECT |

良いプロジェクション:
- 特定の読み取りユースケースに最適化
- イベントから冪等に再構築可能
- Writeモデルから完全に独立

## Query側の設計

ControllerはQueryGatewayを使う。Repositoryを直接使わない。

レイヤー間の型:
- `application/query/` - Query結果の型（例: `OrderDetail`）
- `adapter/protocol/` - RESTレスポンスの型（例: `OrderDetailResponse`）
- QueryHandlerはapplication層の型を返し、Controllerがadapter層の型に変換

```kotlin
// application/query/OrderDetail.kt
data class OrderDetail(
    val orderId: String,
    val customerName: String,
    val totalAmount: Money
)

// adapter/protocol/OrderDetailResponse.kt
data class OrderDetailResponse(...) {
    companion object {
        fun from(detail: OrderDetail) = OrderDetailResponse(...)
    }
}

// QueryHandler - application層の型を返す
@QueryHandler
fun handle(query: GetOrderDetailQuery): OrderDetail? {
    val entity = repository.findById(query.id) ?: return null
    return OrderDetail(...)
}

// Controller - adapter層の型に変換
@GetMapping("/{id}")
fun getById(@PathVariable id: String): ResponseEntity<OrderDetailResponse> {
    val detail = queryGateway.query(
        GetOrderDetailQuery(id),
        OrderDetail::class.java
    ).join() ?: throw NotFoundException("...")

    return ResponseEntity.ok(OrderDetailResponse.from(detail))
}
```

構成:
```
Controller (adapter) → QueryGateway → QueryHandler (application) → Repository
     ↓                                      ↓
Response.from(detail)                  OrderDetail
```

## 結果整合性

| 状況 | 対応 |
|------|------|
| UIが即座に更新を期待している | 設計見直し or ポーリング/WebSocket |
| 整合性遅延が許容範囲を超える | アーキテクチャ再検討 |
| 補償トランザクションが未定義 | 障害シナリオの検討を要求 |

## Saga vs EventHandler

Sagaは「競合が発生する複数アグリゲート間の操作」にのみ使用する。

Sagaが必要なケース:
```
複数のアクターが同じリソースを取り合う場合
例: 在庫確保（10人が同時に同じ商品を注文）

OrderPlacedEvent
  ↓ InventoryReservationSaga
ReserveInventoryCommand → Inventory集約（同時実行を直列化）
  ↓
InventoryReservedEvent → ConfirmOrderCommand
InventoryReservationFailedEvent → CancelOrderCommand
```

Sagaが不要なケース:
```
競合が発生しない操作
例: 注文キャンセル時の在庫解放

OrderCancelledEvent
  ↓ InventoryReleaseHandler（単純なEventHandler）
ReleaseInventoryCommand
  ↓
InventoryReleasedEvent
```

判断基準:

| 状況 | Saga | EventHandler |
|------|------|--------------|
| リソースの取り合いがある | 使う | - |
| 補償トランザクションが必要 | 使う | - |
| 競合しない単純な連携 | - | 使う |
| 失敗時は再試行で十分 | - | 使う |

アンチパターン:
```kotlin
// NG - ライフサイクル管理のためにSagaを使う
@Saga
class OrderLifecycleSaga {
    // 注文の全状態遷移をSagaで追跡
    // PLACED → CONFIRMED → SHIPPED → DELIVERED
}

// OK - 結果整合性が必要な操作だけをSagaで処理
@Saga
class InventoryReservationSaga {
    // 在庫確保の同時実行制御のみ
}
```

Sagaはライフサイクル管理ツールではない。結果整合性が必要な「操作」単位で作成する。

## 例外 vs イベント（失敗時の選択）

監査不要な失敗は例外、監査が必要な失敗はイベント。

例外アプローチ（推奨: ほとんどのケース）:
```kotlin
// ドメインモデル: バリデーション失敗時に例外をスロー
fun reserveInventory(orderId: String, quantity: Int): InventoryReservedEvent {
    if (availableQuantity < quantity) {
        throw InsufficientInventoryException("在庫が不足しています")
    }
    return InventoryReservedEvent(productId, orderId, quantity)
}

// Saga: exceptionally でキャッチして補償アクション
commandGateway.send<Any>(command)
    .exceptionally { ex ->
        commandGateway.send<Any>(CancelOrderCommand(
            orderId = orderId,
            reason = ex.cause?.message ?: "在庫確保に失敗しました"
        ))
        null
    }
```

イベントアプローチ（稀なケース）:
```kotlin
// 監査が必要な場合のみ
data class PaymentFailedEvent(
    val paymentId: String,
    val reason: String,
    val attemptedAmount: Money
) : PaymentEvent
```

判断基準:

| 質問 | 例外 | イベント |
|------|------|----------|
| この失敗を後で確認する必要があるか? | No | Yes |
| 規制やコンプライアンスで記録が必要か? | No | Yes |
| Sagaだけが失敗を気にするか? | Yes | No |
| Event Storeに残すと価値があるか? | No | Yes |

デフォルトは例外アプローチ。監査要件がある場合のみイベントを検討する。

## 抽象化レベルの評価

**条件分岐の肥大化検出**

| パターン | 判定 |
|---------|------|
| 同じif-elseパターンが3箇所以上 | ポリモーフィズムで抽象化 → REJECT |
| switch/caseが5分岐以上 | Strategy/Mapパターンを検討 |
| イベント種別による分岐が増殖 | イベントハンドラを分離 → REJECT |
| Aggregate内の状態分岐が複雑 | State Patternを検討 |

**抽象度の不一致検出**

| パターン | 問題 | 修正案 |
|---------|------|--------|
| CommandHandlerにDB操作詳細 | 責務違反 | Repository層に分離 |
| EventHandlerにビジネスロジック | 責務違反 | ドメインサービスに抽出 |
| Aggregateに永続化処理 | レイヤー違反 | EventStore経由に変更 |
| Projectionに計算ロジック | 保守困難 | 専用サービスに抽出 |

良い抽象化の例:

```kotlin
// イベント種別による分岐の増殖（NG）
@EventHandler
fun on(event: DomainEvent) {
    when (event) {
        is OrderPlacedEvent -> handleOrderPlaced(event)
        is OrderConfirmedEvent -> handleOrderConfirmed(event)
        is OrderShippedEvent -> handleOrderShipped(event)
        // ...どんどん増える
    }
}

// イベントごとにハンドラを分離（OK）
@EventHandler
fun on(event: OrderPlacedEvent) { ... }

@EventHandler
fun on(event: OrderConfirmedEvent) { ... }

@EventHandler
fun on(event: OrderShippedEvent) { ... }
```

```kotlin
// 状態による分岐が複雑（NG）
fun process(command: ProcessCommand) {
    when (status) {
        PENDING -> if (command.type == "approve") { ... } else if (command.type == "reject") { ... }
        APPROVED -> if (command.type == "ship") { ... }
        // ...複雑化
    }
}

// State Patternで抽象化（OK）
sealed class OrderState {
    abstract fun handle(command: ProcessCommand): List<DomainEvent>
}
class PendingState : OrderState() {
    override fun handle(command: ProcessCommand) = when (command) {
        is ApproveCommand -> listOf(OrderApprovedEvent(...))
        is RejectCommand -> listOf(OrderRejectedEvent(...))
        else -> throw InvalidCommandException()
    }
}
```

## アンチパターン検出

以下を見つけたら REJECT:

| アンチパターン | 問題 |
|---------------|------|
| CRUD偽装 | CQRSの形だけ真似てCRUD実装 |
| Anemic Domain Model | Aggregateが単なるデータ構造 |
| Event Soup | 意味のないイベントが乱発される |
| Temporal Coupling | イベント順序に暗黙の依存 |
| Missing Events | 重要なドメインイベントが欠落 |
| God Aggregate | 1つのAggregateに全責務が集中 |

## テスト戦略

レイヤーごとにテスト方針を分ける。

テストピラミッド:
```
        ┌─────────────┐
        │   E2E Test  │  ← 少数: 全体フロー確認
        ├─────────────┤
        │ Integration │  ← Command→Event→Projection→Query の連携確認
        ├─────────────┤
        │  Unit Test  │  ← 多数: 各レイヤー独立テスト
        └─────────────┘
```

Command側（Aggregate）:
```kotlin
// AggregateTestFixture使用
@Test
fun `確定コマンドでイベントが発行される`() {
    fixture
        .given(OrderPlacedEvent(...))
        .`when`(ConfirmOrderCommand(orderId, confirmedBy))
        .expectSuccessfulHandlerExecution()
        .expectEvents(OrderConfirmedEvent(...))
}
```

Query側:
```kotlin
// Read Model直接セットアップ + QueryGateway
@Test
fun `注文詳細が取得できる`() {
    // Given: Read Modelを直接セットアップ
    orderRepository.save(OrderEntity(...))

    // When: QueryGateway経由でクエリ実行
    val detail = queryGateway.query(GetOrderDetailQuery(orderId), ...).join()

    // Then
    assertEquals(expectedDetail, detail)
}
```

チェック項目:

| 観点 | 判定 |
|------|------|
| Aggregateテストが状態ではなくイベントを検証している | 必須 |
| Query側テストがCommand経由でデータを作っていない | 推奨 |
| 統合テストでAxonの非同期処理を考慮している | 必須 |

## インフラ層

確認事項:
- イベントストアの選択は適切か
- メッセージング基盤は要件を満たすか
- スナップショット戦略は定義されているか
- イベントのシリアライズ形式は適切か
