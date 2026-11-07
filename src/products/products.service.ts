import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProductDto, UpdateProductDto } from "./dto/product.dto";
import {
  CreateProductPriceDto,
  UpdateProductPriceDto,
} from "./dto/product-price.dto";
import { CreateCategoryDto, UpdateCategoryDto } from "./dto/category.dto";
import {
  BookingStatus,
  Prisma,
  PurchaseStatus,
  RedemptionStatus,
} from "@generated/prisma";
import { CursorPaginationDto } from "../dto/common/pagination.dto";
import { SearchProductVariantDto } from "./dto/search-product-variant.dto";
import { VCGamersService } from "../providers/vendor-api/implementations/vcgamers/vcgamers.service";
import { SearchProductDto } from "./dto/search-product.dto";
import {
  CreateProductInputFieldDto,
  UpdateProductInputFieldDto,
} from "./dto/product-input-field.dto";
import { ProductCacheService } from "../valkey/services/product-cache.service";
import { CacheManagerService } from "../valkey/services/cache-manager.service";
import { PaymentFeaturedResponseDto } from "./dto/payment-featured.dto";
import { resolveDeliveryType } from "../delivery/delivery.types";

// Known product codes for featured payment items
const PULSA_DATA_PRODUCT_CODES = ["PSATL", "PSAIN", "XL"];
const GAMING_PRODUCT_CODES = ["MLBB", "FF", "PUBGM", "CODM"];
const PLN_PRODUCT_CODE = "PLN";
const PAYMENT_FEATURED_CACHE_KEY = "payment-featured:config";
const PAYMENT_FEATURED_CACHE_TTL = 3600; // 1 hour
const RECOMMENDATIONS_CACHE_KEY = "products:recommendations";
const RECOMMENDATIONS_CACHE_TTL = 1800; // 30 minutes
const PERSONALIZED_RECOMMENDATIONS_CACHE_TTL = 900; // 15 minutes
const TRENDING_CACHE_KEY = "products:trending";
const TRENDING_CACHE_TTL = 300; // 5 minutes
const NEW_ARRIVALS_CACHE_KEY = "products:new-arrivals";
const NEW_ARRIVALS_CACHE_TTL = 3600; // 1 hour

// Standard product include for consistency
const productInclude = {
  category: true,
  variants: {
    include: {
      ProductPrice: {
        include: {
          vendor: true,
        },
      },
    },
  },
} as const;

// Lean select for recommendation cards — only what the home screen needs
const recommendationSelect = {
  id: true,
  name: true,
  imageUrl: true,
  code: true,
  categoryId: true,
  isVoucher: true,
  category: {
    select: { id: true, name: true },
  },
  variants: {
    where: { isActive: true },
    select: {
      ProductPrice: {
        where: { isActive: true },
        select: { sellPrice: true, currency: true },
        orderBy: { sellPrice: "asc" as const },
        take: 1,
      },
    },
  },
} as const;

type RecommendationRaw = Prisma.ProductGetPayload<{
  select: typeof recommendationSelect;
}>;

// Catalog-search page size. DEFAULT applies when the caller omits `take`;
// MAX is the ceiling we silently clamp to. We clamp (not 400) so the agent
// never has to recover from an over-large request, and we keep this local
// to search() rather than on the shared CursorPaginationDto so other
// paginated endpoints (dashboards, b2b) can still use larger pages.
const SEARCH_DEFAULT_TAKE = 12;
const SEARCH_MAX_TAKE = 24;

function clampSearchTake(take: number | undefined): number {
  if (typeof take !== "number" || !Number.isFinite(take) || take <= 0) {
    return SEARCH_DEFAULT_TAKE;
  }
  return Math.min(Math.floor(take), SEARCH_MAX_TAKE);
}

// A product's lowest active variant price ("from X points"). Mirrors the
// figure surfaced to the agent/UI, so cheapest-first ordering matches the
// "from" cost the user sees. Returns +Infinity for unpriced products so
// they sort last.
function lowestActivePoints(product: {
  variants: {
    isActive: boolean;
    ProductPrice: { isActive: boolean; sellPrice: Prisma.Decimal }[];
  }[];
}): number {
  let min = Number.POSITIVE_INFINITY;
  for (const variant of product.variants) {
    if (!variant.isActive) continue;
    for (const price of variant.ProductPrice) {
      if (!price.isActive) continue;
      const n = Number(price.sellPrice);
      if (Number.isFinite(n) && n < min) min = n;
    }
  }
  return min;
}

function toRecommendationDto(product: RecommendationRaw) {
  const lowestPrice = product.variants
    .flatMap((v) => v.ProductPrice)
    .sort((a, b) => Number(a.sellPrice) - Number(b.sellPrice))[0];

  return {
    id: product.id,
    name: product.name,
    imageUrl: product.imageUrl,
    code: product.code,
    categoryId: product.categoryId,
    isVoucher: product.isVoucher,
    category: product.category,
    startingPrice: lowestPrice
      ? {
          amount: lowestPrice.sellPrice.toString(),
          currency: lowestPrice.currency,
        }
      : null,
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vcGamersService: VCGamersService,
    private readonly productCache: ProductCacheService,
    private readonly cacheManager: CacheManagerService,
  ) {}

  findAll(paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;
    const cacheKey = `${cursor ?? "first"}:t${take}:s${skip ?? 0}`;

    return this.productCache.getProductList(cacheKey, async () => {
      const findArgs = {
        take,
        skip: useSkip ? skip : cursor ? 1 : 0,
        cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
      };

      const [items, total] = await Promise.all([
        this.prisma.product.findMany({
          ...findArgs,
          include: productInclude,
          orderBy: {
            name: "asc",
          },
        }),
        this.prisma.product.count(),
      ]);

      return { items, total };
    });
  }

  async search(params: SearchProductDto, paginationDto: CursorPaginationDto) {
    const { cursor, skip } = paginationDto;
    // The API is the authority on page size — never trust the client's
    // `take` (the agent, or any API-key holder, can ask for thousands).
    const take = clampSearchTake(paginationDto.take);
    const useSkip = typeof skip === "number" && skip > 0;
    const {
      query,
      vendorId,
      active,
      code,
      id,
      name,
      categoryId,
      categoryName,
      vendorName,
      isVoucher,
      minPoints,
      maxPoints,
    } = params;

    const where: Prisma.ProductWhereInput = {};

    if (id) {
      where.id = id;
    }

    if (code) {
      where.code = {
        contains: code,
        mode: "insensitive",
      };
    }

    if (name) {
      where.name = {
        contains: name,
        mode: "insensitive",
      };
    }

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (categoryName) {
      where.category = {
        name: {
          contains: categoryName,
          mode: "insensitive",
        },
      };
    }

    if (vendorName) {
      where.variants = {
        some: {
          ProductPrice: {
            some: {
              vendor: {
                name: {
                  contains: vendorName,
                  mode: "insensitive",
                },
              },
            },
          },
        },
      };
    }

    if (query && !id && !code && !name && !vendorName) {
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { code: { contains: query, mode: "insensitive" } },
        {
          category: { name: { contains: query, mode: "insensitive" } },
        },
        {
          variants: {
            some: {
              ProductPrice: {
                some: {
                  vendor: {
                    name: {
                      contains: query,
                      mode: "insensitive",
                    },
                  },
                },
              },
            },
          },
        },
      ];
    }

    if (vendorId) {
      where.variants = {
        some: {
          ProductPrice: {
            some: {
              vendorId: vendorId,
            },
          },
        },
      };
    }

    if (active !== undefined) {
      where.isActive = active;
    }

    if (isVoucher !== undefined) {
      where.isVoucher = isVoucher;
    }

    // Points range — `ProductPrice.sellPrice` is the points cost. A product
    // matches if it has at least one active variant with an active price in
    // range. Applied via `AND` (not `where.variants`) so it composes with
    // the vendor/query filters above instead of overwriting them.
    const isPointsQuery = minPoints !== undefined || maxPoints !== undefined;
    if (isPointsQuery) {
      const sellPrice: Prisma.DecimalFilter = {};
      if (minPoints !== undefined) sellPrice.gte = minPoints;
      if (maxPoints !== undefined) sellPrice.lte = maxPoints;
      where.AND = [
        {
          variants: {
            some: {
              isActive: true,
              ProductPrice: { some: { isActive: true, sellPrice } },
            },
          },
        },
      ];
    }

    // Cheapest-first for points queries. "Cheapest" = the product's lowest
    // active variant price, which Prisma can't express as a relation
    // `orderBy`. We must rank the ENTIRE matching set — a points budget
    // (e.g. "what can I get with 16k") matches most of the catalog, so
    // ranking only an alphabetical slice would silently drop genuinely
    // cheaper products and surface a wrong "cheapest". To stay cheap we
    // first project just {id + active prices} for every match, sort by true
    // lowest active price, then hydrate ONLY the requested page with the
    // full product shape. Non-points searches keep the existing
    // cursor-paginated, name-ordered path untouched.
    if (isPointsQuery) {
      const ranked = await this.prisma.product.findMany({
        where,
        select: {
          id: true,
          variants: {
            select: {
              isActive: true,
              ProductPrice: { select: { isActive: true, sellPrice: true } },
            },
          },
        },
      });
      ranked.sort((a, b) => lowestActivePoints(a) - lowestActivePoints(b));

      const total = ranked.length;
      const start = useSkip ? skip : 0;
      const pageIds = ranked.slice(start, start + take).map((p) => p.id);

      const products = await this.prisma.product.findMany({
        where: { id: { in: pageIds } },
        include: productInclude,
      });
      // `findMany({ id: { in } })` does not preserve our ranked order — re-key
      // by id and emit in the cheapest-first sequence we computed.
      const byId = new Map(products.map((p) => [p.id, p]));
      const items = pageIds
        .map((id) => byId.get(id))
        .filter((p): p is (typeof products)[number] => p !== undefined);
      return { items, total };
    }

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    // Search queries are not cached due to high variability
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        ...findArgs,
        where,
        include: productInclude,
        orderBy: {
          name: "asc",
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  async findVouchers(paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;
    const where: Prisma.ProductWhereInput = {
      isVoucher: true,
      isActive: true,
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        ...findArgs,
        where,
        include: productInclude,
        orderBy: {
          name: "asc",
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  async findNonVouchers(paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;
    const where: Prisma.ProductWhereInput = {
      isVoucher: false,
      isActive: true,
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        ...findArgs,
        where,
        include: productInclude,
        orderBy: {
          name: "asc",
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  async findAllCategories(
    paginationDto: CursorPaginationDto,
    includeInactive = false,
  ) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    // Default to active categories only — inactive ones are an admin/CMS
    // concern and should not leak into the agent catalog or storefront.
    // Admin tooling opts back in with `includeInactive`.
    const where: Prisma.CategoryWhereInput = includeInactive
      ? {}
      : { isActive: true };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.category.findMany({
        ...findArgs,
        where,
        orderBy: {
          name: "asc",
        },
      }),
      this.prisma.category.count({ where }),
    ]);

    return { items, total };
  }

  findByCategory(categoryId: string) {
    return this.productCache.getProductsByCategory(categoryId, () => {
      return this.prisma.product.findMany({
        where: { categoryId },
        include: productInclude,
      });
    });
  }

  async findByCode(code: string) {
    const product = await this.productCache.getProductByCode(code, () => {
      return this.prisma.product.findFirst({
        where: { code },
        include: productInclude,
      });
    });

    if (!product) {
      throw new NotFoundException(`Product with code ${code} not found`);
    }

    return product;
  }

  async findPrices(id: string) {
    const product = await this.productCache.getProductPrices(id, () => {
      return this.prisma.product.findUnique({
        where: { id },
        include: {
          variants: {
            include: {
              ProductPrice: {
                include: {
                  vendor: true,
                },
              },
            },
          },
        },
      });
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    const prices = product.variants.flatMap((variant) => variant.ProductPrice);
    return prices;
  }

  async createPrice(productVariantId: string, data: CreateProductPriceDto) {
    const productVariant = await this.prisma.productVariant.findUnique({
      where: { id: productVariantId },
    });

    if (!productVariant) {
      throw new NotFoundException(
        `Product variant with ID ${productVariantId} not found`,
      );
    }

    try {
      const price = await this.prisma.productPrice.create({
        data: {
          ...data,
          productVariantId,
        },
        include: {
          vendor: true,
          productVariant: true,
        },
      });

      // Invalidate product cache after price creation
      await this.productCache.invalidateProduct(productVariant.productId);

      return price;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException("Failed to create product price");
      }
      throw error;
    }
  }

  async updatePrice(priceId: string, data: UpdateProductPriceDto) {
    try {
      const price = await this.prisma.productPrice.update({
        where: { id: priceId },
        data,
        include: {
          vendor: true,
          productVariant: true,
        },
      });

      // Invalidate product cache after price update
      await this.productCache.invalidateProduct(price.productVariant.productId);

      return price;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Price with ID ${priceId} not found`);
      }
      throw error;
    }
  }

  async removePrice(priceId: string) {
    try {
      // Get price with variant to know which product to invalidate
      const existingPrice = await this.prisma.productPrice.findUnique({
        where: { id: priceId },
        include: { productVariant: true },
      });

      const result = await this.prisma.productPrice.delete({
        where: { id: priceId },
      });

      // Invalidate product cache after price deletion
      if (existingPrice) {
        await this.productCache.invalidateProduct(
          existingPrice.productVariant.productId,
        );
      }

      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Price with ID ${priceId} not found`);
      }
      throw error;
    }
  }

  async findOne(id: string) {
    const product = await this.productCache.getProductDetails(id, () => {
      return this.prisma.product.findUnique({
        where: { id },
        include: productInclude,
      });
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    return product;
  }

  async create(data: CreateProductDto) {
    const product = await this.prisma.product.create({
      data,
      include: {
        category: true,
        variants: true,
      },
    });

    // Invalidate catalog cache after product creation
    await this.productCache.invalidateProduct();

    return product;
  }

  async update(id: string, data: UpdateProductDto) {
    try {
      const product = await this.prisma.product.update({
        where: { id },
        data,
        include: productInclude,
      });

      // Invalidate specific product cache after update
      await this.productCache.invalidateProduct(id);

      return product;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }
      throw error;
    }
  }

  async remove(id: string) {
    try {
      const result = await this.prisma.product.delete({
        where: { id },
      });

      // Invalidate product cache after deletion
      await this.productCache.invalidateProduct(id);

      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }
      throw error;
    }
  }

  async findOneCategory(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        Product: true,
      },
    });

    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    return category;
  }

  async createCategory(data: CreateCategoryDto) {
    const category = await this.prisma.category.create({
      data,
      include: {
        Product: true,
      },
    });

    // Invalidate category cache after creation
    await this.productCache.invalidateCategory();

    return category;
  }

  async updateCategory(id: string, data: UpdateCategoryDto) {
    try {
      const category = await this.prisma.category.update({
        where: { id },
        data,
        include: {
          Product: true,
        },
      });

      // Invalidate category cache after update
      await this.productCache.invalidateCategory(id);

      return category;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Category with ID ${id} not found`);
      }
      throw error;
    }
  }

  async removeCategory(id: string) {
    try {
      const result = await this.prisma.category.delete({
        where: { id },
      });

      // Invalidate category cache after deletion
      await this.productCache.invalidateCategory(id);

      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Category with ID ${id} not found`);
      }
      throw error;
    }
  }

  async findVariants(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    return this.productCache.getProductVariants(productId, () => {
      return this.prisma.productVariant.findMany({
        where: { productId },
        include: {
          ProductPrice: {
            include: {
              vendor: true,
            },
          },
        },
        orderBy: {
          name: "asc",
        },
      });
    });
  }

  async findOneVariant(id: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id },
      include: {
        product: true,
        // Newest active first: that is the only row `POST /bookings` accepts.
        ProductPrice: {
          include: {
            vendor: true,
          },
          orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
        },
      },
    });

    if (!variant) {
      throw new NotFoundException(`Product variant with ID ${id} not found`);
    }

    // `voucherTemplate` is ops parser config, not product data; the
    // resolved `deliveryType` is what checkout needs ("Delivered as …").
    const { voucherTemplate: _template, ...product } = variant.product;
    return {
      ...variant,
      product: {
        ...product,
        deliveryType: resolveDeliveryType(variant.product),
      },
    };
  }

  async searchVariants(
    params: SearchProductVariantDto,
    paginationDto: CursorPaginationDto,
  ) {
    const { cursor, take = 10 } = paginationDto;
    const { variantCode, name, productId, isActive, query } = params;

    const where: Prisma.ProductVariantWhereInput = {};

    if (variantCode) {
      where.variantCode = {
        contains: variantCode,
        mode: "insensitive",
      };
    }

    if (name) {
      where.name = {
        contains: name,
        mode: "insensitive",
      };
    }

    if (productId) {
      where.productId = productId;
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (query && !variantCode && !name) {
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { variantCode: { contains: query, mode: "insensitive" } },
      ];
    }

    // Search queries are not cached due to high variability
    return await this.prisma.productVariant.findMany({
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      where,
      include: {
        product: true,
        ProductPrice: {
          include: {
            vendor: true,
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });
  }

  async findAllGroupedByCategories(take?: number) {
    return this.productCache.getCatalogGrouped(async () => {
      const categories = await this.prisma.category.findMany({
        select: {
          id: true,
          name: true,
          Product: {
            take: take ? take : 6,
            where: {
              isActive: true,
            },
            select: {
              id: true,
              name: true,
              description: true,
              imageUrl: true,
              code: true,
              categoryId: true,
              isActive: true,
              isVoucher: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        where: {
          isActive: true,
          Product: {
            some: {
              isActive: true,
            },
          },
        },
        orderBy: {
          name: "asc",
        },
      });

      return categories.map((category) => {
        return {
          category: {
            id: category.id,
            name: category.name,
          },
          products: category.Product,
        };
      });
    });
  }

  async createProductInputField(
    productId: string,
    createInputFieldDto: CreateProductInputFieldDto,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    const inputField = await this.prisma.productInputField.create({
      data: {
        product: {
          connect: { id: productId },
        },
        forms: JSON.parse(JSON.stringify(createInputFieldDto.fields)),
      },
    });

    // Invalidate product cache after input field creation
    await this.productCache.invalidateProduct(productId);

    return inputField;
  }

  async updateProductInputField(
    productId: string,
    fieldId: string,
    updateInputFieldDto: UpdateProductInputFieldDto,
  ) {
    const existingField = await this.prisma.productInputField.findFirst({
      where: {
        id: fieldId,
        productId,
      },
    });

    if (!existingField) {
      throw new NotFoundException(
        `Input field with ID ${fieldId} not found for product ${productId}`,
      );
    }

    if (
      !updateInputFieldDto.fields ||
      updateInputFieldDto.fields.length === 0
    ) {
      throw new BadRequestException("No form fields provided for update");
    }

    const inputField = await this.prisma.productInputField.update({
      where: { id: fieldId },
      data: {
        forms: JSON.parse(JSON.stringify(updateInputFieldDto.fields)),
      },
    });

    // Invalidate product cache after input field update
    await this.productCache.invalidateProduct(productId);

    return inputField;
  }

  async deleteProductInputField(productId: string, fieldId: string) {
    const existingField = await this.prisma.productInputField.findFirst({
      where: {
        id: fieldId,
        productId,
      },
    });

    if (!existingField) {
      throw new NotFoundException(
        `Input field with ID ${fieldId} not found for product ${productId}`,
      );
    }

    const result = await this.prisma.productInputField.delete({
      where: { id: fieldId },
    });

    // Invalidate product cache after input field deletion
    await this.productCache.invalidateProduct(productId);

    return result;
  }

  async getRecommendations(limit = 10) {
    return this.cacheManager.cacheAside(
      `${RECOMMENDATIONS_CACHE_KEY}:${limit}`,
      () => this.fetchRecommendations(limit),
      { ttl: RECOMMENDATIONS_CACHE_TTL },
    );
  }

  private async fetchRecommendations(limit: number) {
    // Get product variant IDs ranked by completed purchase count
    const purchaseCounts = await this.prisma.purchase.groupBy({
      by: ["productVariantId"],
      _count: { productVariantId: true },
      where: { status: PurchaseStatus.COMPLETED },
      orderBy: { _count: { productVariantId: "desc" } },
      take: limit * 3, // fetch extra variants to account for deduplication
    });

    const rankedProductIds: string[] = [];

    if (purchaseCounts.length > 0) {
      const variantIds = purchaseCounts.map((p) => p.productVariantId);
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: variantIds }, isActive: true },
        select: { id: true, productId: true },
      });

      const variantToProduct = new Map(
        variants.map((v) => [v.id, v.productId]),
      );
      const seen = new Set<string>();

      for (const { productVariantId } of purchaseCounts) {
        const productId = variantToProduct.get(productVariantId);
        if (productId && !seen.has(productId)) {
          seen.add(productId);
          rankedProductIds.push(productId);
          if (rankedProductIds.length >= limit) break;
        }
      }
    }

    const rankedProducts =
      rankedProductIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: rankedProductIds }, isActive: true },
            select: recommendationSelect,
          })
        : [];

    if (rankedProducts.length >= limit) {
      return rankedProductIds
        .map((id) => rankedProducts.find((p) => p.id === id))
        .filter(Boolean)
        .slice(0, limit)
        .map(toRecommendationDto);
    }

    // Pad with most recently active products to fill up to limit
    const fallbackProducts = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(rankedProductIds.length > 0 && {
          id: { notIn: rankedProductIds },
        }),
      },
      select: recommendationSelect,
      orderBy: { createdAt: "desc" },
      take: limit - rankedProducts.length,
    });

    const sortedRanked = rankedProductIds
      .map((id) => rankedProducts.find((p) => p.id === id))
      .filter(Boolean);

    return [...sortedRanked, ...fallbackProducts].map(toRecommendationDto);
  }

  async getPersonalizedRecommendations(
    userId: string,
    walletAddress: string | undefined,
    limit: number,
  ) {
    const cacheKey = `recommendations:personalized:${userId}:${limit}`;
    return this.cacheManager.cacheAside(
      cacheKey,
      () => this.fetchPersonalizedRecommendations(userId, walletAddress, limit),
      { ttl: PERSONALIZED_RECOMMENDATIONS_CACHE_TTL },
    );
  }

  private async fetchPersonalizedRecommendations(
    userId: string,
    walletAddress: string | undefined,
    limit: number,
  ) {
    // Parallel fetch: recent bookings (purchase intent) + redemptions (confirmed spend)
    const [recentBookings, recentRedemptions] = await Promise.all([
      walletAddress
        ? this.prisma.bookingOrder.findMany({
            where: {
              walletAddress: { equals: walletAddress, mode: "insensitive" },
              status: {
                in: [BookingStatus.EXECUTED, BookingStatus.PENDING],
              },
            },
            select: {
              productVariant: {
                select: {
                  productId: true,
                  product: { select: { categoryId: true } },
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 20,
          })
        : Promise.resolve([]),
      this.prisma.pointRedemption.findMany({
        where: { userId },
        select: {
          productVariant: {
            select: {
              productId: true,
              product: { select: { categoryId: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // Build category affinity map + set of already-purchased product IDs
    const categoryCount = new Map<string, number>();
    const interactedProductIds = new Set<string>();

    for (const booking of recentBookings) {
      const { productId, product } = booking.productVariant;
      interactedProductIds.add(productId);
      categoryCount.set(
        product.categoryId,
        (categoryCount.get(product.categoryId) ?? 0) + 1,
      );
    }

    for (const redemption of recentRedemptions) {
      const { productId, product } = redemption.productVariant;
      interactedProductIds.add(productId);
      // Weight redemptions slightly higher (confirmed spend = stronger signal)
      categoryCount.set(
        product.categoryId,
        (categoryCount.get(product.categoryId) ?? 0) + 2,
      );
    }

    // Cold start: new user with no activity → fall back to global popular
    if (categoryCount.size === 0) {
      return this.getRecommendations(limit);
    }

    // Sort categories by affinity score, take top 3
    const topCategories = [...categoryCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([categoryId]) => categoryId);

    // Single query: fetch active products from affinity categories, excluding interacted ones
    const raw = await this.prisma.product.findMany({
      where: {
        isActive: true,
        categoryId: { in: topCategories },
        ...(interactedProductIds.size > 0 && {
          id: { notIn: [...interactedProductIds] },
        }),
      },
      select: recommendationSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Re-sort to respect category affinity order, then map to lean DTO
    const categoryOrder = new Map(topCategories.map((id, i) => [id, i]));
    const personalizedProducts = raw
      .sort(
        (a, b) =>
          (categoryOrder.get(a.categoryId) ?? 999) -
          (categoryOrder.get(b.categoryId) ?? 999),
      )
      .map(toRecommendationDto);

    if (personalizedProducts.length >= limit) {
      return personalizedProducts.slice(0, limit);
    }

    // Fill remaining slots from global popular (already cached, no extra DB hit)
    const globalRecs = await this.getRecommendations(limit);
    const personalizedIds = new Set(personalizedProducts.map((p) => p.id));
    const globalFill = globalRecs
      .filter((p) => !personalizedIds.has(p.id))
      .slice(0, limit - personalizedProducts.length);

    return [...personalizedProducts, ...globalFill];
  }

  async getTrending(limit = 10) {
    return this.cacheManager.cacheAside(
      `${TRENDING_CACHE_KEY}:${limit}`,
      async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [purchaseCounts, redemptionCounts] = await Promise.all([
          this.prisma.purchase.groupBy({
            by: ["productVariantId"],
            _count: { productVariantId: true },
            where: {
              status: PurchaseStatus.COMPLETED,
              createdAt: { gte: since },
            },
            orderBy: { _count: { productVariantId: "desc" } },
            take: limit * 3,
          }),
          this.prisma.pointRedemption.groupBy({
            by: ["productVariantId"],
            _count: { productVariantId: true },
            where: {
              status: RedemptionStatus.COMPLETED,
              createdAt: { gte: since },
            },
            orderBy: { _count: { productVariantId: "desc" } },
            take: limit * 3,
          }),
        ]);

        // Merge counts by variantId
        const countMap = new Map<string, number>();
        for (const p of purchaseCounts) {
          countMap.set(
            p.productVariantId,
            (countMap.get(p.productVariantId) ?? 0) + p._count.productVariantId,
          );
        }
        for (const r of redemptionCounts) {
          countMap.set(
            r.productVariantId,
            (countMap.get(r.productVariantId) ?? 0) + r._count.productVariantId,
          );
        }

        // Sort by total count descending, take top limit*3 variantIds
        const rankedVariantIds = [...countMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit * 3)
          .map(([variantId]) => variantId);

        if (rankedVariantIds.length === 0) {
          return [];
        }

        // Get productIds from variants (dedup logic same as fetchRecommendations)
        const variants = await this.prisma.productVariant.findMany({
          where: { id: { in: rankedVariantIds }, isActive: true },
          select: { id: true, productId: true },
        });

        const variantToProduct = new Map(
          variants.map((v) => [v.id, v.productId]),
        );
        const seen = new Set<string>();
        const rankedProductIds: string[] = [];

        for (const variantId of rankedVariantIds) {
          const productId = variantToProduct.get(variantId);
          if (productId && !seen.has(productId)) {
            seen.add(productId);
            rankedProductIds.push(productId);
            if (rankedProductIds.length >= limit * 3) break;
          }
        }

        const products = await this.prisma.product.findMany({
          where: { id: { in: rankedProductIds }, isActive: true },
          select: recommendationSelect,
        });

        return rankedProductIds
          .map((id) => products.find((p) => p.id === id))
          .filter(Boolean)
          .slice(0, limit)
          .map(toRecommendationDto);
      },
      { ttl: TRENDING_CACHE_TTL },
    );
  }

  getNewArrivals(limit = 10) {
    return this.cacheManager.cacheAside(
      `${NEW_ARRIVALS_CACHE_KEY}:${limit}`,
      async () => {
        const products = await this.prisma.product.findMany({
          where: { isActive: true },
          select: recommendationSelect,
          orderBy: { createdAt: "desc" },
          take: limit,
        });
        return products.map(toRecommendationDto);
      },
      { ttl: NEW_ARRIVALS_CACHE_TTL },
    );
  }

  getSearchSuggestions(query: string) {
    if (!query.trim()) {
      return Promise.resolve([]);
    }

    return this.prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { startsWith: query, mode: "insensitive" } },
          { code: { startsWith: query, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        code: true,
        imageUrl: true,
        category: { select: { id: true, name: true } },
      },
      take: 8,
      orderBy: { name: "asc" },
    });
  }

  async getProductStats(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    const variantIds = await this.prisma.productVariant
      .findMany({
        where: { productId, isActive: true },
        select: { id: true },
      })
      .then((v) => v.map((x) => x.id));

    if (variantIds.length === 0) {
      return {
        productId,
        totalSales: 0,
        totalPurchases: 0,
        totalRedemptions: 0,
        salesToday: 0,
      };
    }

    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const [purchaseCount, redemptionCount, purchasesToday, redemptionsToday] =
      await Promise.all([
        this.prisma.purchase.count({
          where: {
            productVariantId: { in: variantIds },
            status: PurchaseStatus.COMPLETED,
          },
        }),
        this.prisma.pointRedemption.count({
          where: {
            productVariantId: { in: variantIds },
            status: RedemptionStatus.COMPLETED,
          },
        }),
        this.prisma.purchase.count({
          where: {
            productVariantId: { in: variantIds },
            status: PurchaseStatus.COMPLETED,
            createdAt: { gte: todayStart },
          },
        }),
        this.prisma.pointRedemption.count({
          where: {
            productVariantId: { in: variantIds },
            status: RedemptionStatus.COMPLETED,
            createdAt: { gte: todayStart },
          },
        }),
      ]);

    return {
      productId,
      totalSales: purchaseCount + redemptionCount,
      totalPurchases: purchaseCount,
      totalRedemptions: redemptionCount,
      salesToday: purchasesToday + redemptionsToday,
    };
  }

  async getPaymentFeatured(): Promise<PaymentFeaturedResponseDto> {
    return this.cacheManager.cacheAside(
      PAYMENT_FEATURED_CACHE_KEY,
      () => this.fetchPaymentFeatured(),
      { ttl: PAYMENT_FEATURED_CACHE_TTL },
    );
  }

  private async fetchPaymentFeatured(): Promise<PaymentFeaturedResponseDto> {
    const [plnProduct, pulsaDataProduct, gamingProduct] = await Promise.all([
      this.prisma.product.findFirst({
        where: {
          code: PLN_PRODUCT_CODE,
          isActive: true,
        },
        select: {
          id: true,
        },
      }),
      this.prisma.product.findFirst({
        where: {
          code: { in: PULSA_DATA_PRODUCT_CODES },
          isActive: true,
        },
        select: {
          category: {
            select: {
              id: true,
            },
          },
        },
      }),
      this.prisma.product.findFirst({
        where: {
          code: { in: GAMING_PRODUCT_CODES },
          isActive: true,
        },
        select: {
          category: {
            select: {
              id: true,
            },
          },
        },
      }),
    ]);

    const result: PaymentFeaturedResponseDto = {};

    if (pulsaDataProduct?.category) {
      result["Pulsa & Data Package"] = { id: pulsaDataProduct.category.id };
    }

    if (gamingProduct?.category) {
      result["Gaming"] = { id: gamingProduct.category.id };
    }

    if (plnProduct) {
      result["Token PLN"] = { id: plnProduct.id };
    }

    return result;
  }
}
